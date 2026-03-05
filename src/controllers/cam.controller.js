const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const cfg = require("../config");
const { uploadImage } = require("../libs/minio");
const { publishEvent } = require("../libs/kafka");
const { insertEvent } = require("../libs/clickhouse");
const { logger } = require("../libs/logger");

// ===== In-memory de-dup & stale guard =====
const SEEN = new Map();                    // key: `${deviceId}:${shotId}` -> { ts, at }
const LAST_TS = new Map();                 // deviceId -> lastTs
const DEDUP_TTL_MS = 10 * 60 * 1000;       // 10 phút
let FIFO = [];                             // để tỉa SEEN

function nowMs() { return Date.now(); }
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function hmacSha256(key, msg) { return crypto.createHmac("sha256", key).update(msg).digest("hex"); }

function rememberShot(deviceId, shotId, ts) {
    const key = `${deviceId}:${shotId}`;
    SEEN.set(key, { ts, at: nowMs() });
    FIFO.push(key);
    if (FIFO.length > 5000) {
        const cut = FIFO.splice(0, 1000);
        const t = nowMs();
        for (const k of cut) {
            const v = SEEN.get(k);
            if (!v || (t - v.at) > DEDUP_TTL_MS) SEEN.delete(k);
        }
    }
}

function seenShot(deviceId, shotId) {
    const key = `${deviceId}:${shotId}`;
    const v = SEEN.get(key);
    if (!v) return false;
    if (nowMs() - v.at > DEDUP_TTL_MS) { SEEN.delete(key); return false; }
    return true;
}

function clientIp(req) {
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
    return (req.socket && req.socket.remoteAddress) || "";
}

exports.upload = async (req, res, next) => {
    try {
        const file = req.file; // multer memoryStorage -> buffer/size/mimetype
        const deviceId = (req.body.deviceId || "").trim();
        const ts = Number(req.body.ts || 0);
        const extraRaw = req.body.extra || "";           // ESP gửi String JSON
        const shotId = req.get("x-shot-id") || "";       // nếu đã bật trên ESP
        const signature = req.get("x-signature") || "";  // nếu bật HMAC

        if (!deviceId || !ts || !file || !file.buffer || !file.size) {
            return res.status(400).json({ ok: false, error: "missing deviceId/ts/file" });
        }

        // (Optional) Verify HMAC nếu .env có HMAC_SECRET
        if (process.env.HMAC_SECRET) {
            const hash = sha256(file.buffer);
            const message = `${deviceId}.${ts}.${hash}`;
            const expect = hmacSha256(process.env.HMAC_SECRET, message);
            if (!signature || signature.toLowerCase() !== expect.toLowerCase()) {
                return res.status(401).json({ ok: false, error: "bad_signature" });
            }
        }

        // 1) De-dup theo {deviceId, shotId}
        if (shotId && seenShot(deviceId, shotId)) {
            return res.status(204).end(); // ảnh trùng -> bỏ qua êm
        }

        // 2) Chặn ảnh cũ theo ts (latest-only)
        const lastTs = LAST_TS.get(deviceId) || 0;
        if (ts <= lastTs) {
            return res.status(204).end(); // ảnh cũ/trễ
        }

        // 3) Parse "extra" JSON (nếu có)
        let extra = null;
        if (typeof extraRaw === "string" && extraRaw.length) {
            try { extra = JSON.parse(extraRaw); }
            catch { extra = { raw: extraRaw }; } // lưu dạng raw nếu parse lỗi
        }

        // 4) Tạo cấu trúc thư mục theo ngày: /uploads/<deviceId>/<YYYY>/<MM>/<DD>/
        let dt;
        const tsStr = String(ts);

        if (tsStr.length === 14) {
            // Format: YYYYMMDDHHMMSS
            const year = tsStr.substring(0, 4);
            const month = tsStr.substring(4, 6);
            const day = tsStr.substring(6, 8);
            const hour = tsStr.substring(8, 10);
            const minute = tsStr.substring(10, 12);
            const second = tsStr.substring(12, 14);
            dt = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
        } else if (ts > 1000000000000) {
            // Timestamp đã là milliseconds
            dt = new Date(ts);
        } else if (ts > 1000000000) {
            // Timestamp là seconds, chuyển sang milliseconds
            dt = new Date(ts * 1000);
        } else {
            // Fallback: sử dụng thời gian hiện tại
            dt = new Date();
        }

        const yyyy = String(dt.getUTCFullYear());
        const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(dt.getUTCDate()).padStart(2, "0");
        const baseDir = path.join(cfg.uploadDir, deviceId, yyyy, mm, dd);
        await fs.mkdir(baseDir, { recursive: true });

        // 5) Tên file: <ts>_<shortShot>.jpg + .json
        const shortShot = shotId ? shotId.slice(-6) : "na";
        const baseName = `${ts}_${shortShot}`;
        const jpgPath = path.join(baseDir, `${baseName}.jpg`);
        const jsonPath = path.join(baseDir, `${baseName}.json`);

        // 6) Lưu ảnh vào filesystem (backward compatibility)
        await fs.writeFile(jpgPath, file.buffer);

        // 7) Upload ảnh lên MinIO (NEW: Streaming architecture)
        let minioResult = null;
        try {
            // Re-init MinIO if needed (in case it wasn't ready at startup)
            const { initMinIO } = require("../libs/minio");
            await initMinIO();

            minioResult = await uploadImage(
                file.buffer,
                deviceId,
                dt,
                shotId || 'na',
                file.mimetype || 'image/jpeg'
            );
            logger.info({ deviceId, shotId, objectKey: minioResult.objectKey }, 'Image uploaded to MinIO');
        } catch (minioError) {
            logger.error({
                error: minioError.message,
                stack: minioError.stack,
                deviceId
            }, 'Failed to upload to MinIO, but continuing with filesystem');
            // Continue even if MinIO fails - backward compatibility
        }

        // 8) Publish event to Kafka (if MinIO upload succeeded)
        if (minioResult) {
            try {
                const eventPayload = {
                    device_id: deviceId,
                    timestamp: dt.toISOString(),
                    shot_id: shotId || '',
                    image_url: minioResult.url,
                    image_size: minioResult.size,
                    image_md5: minioResult.md5,
                    mime_type: file.mimetype || 'image/jpeg',
                    firmware_version: req.get('x-firmware-version') || 'unknown',
                    ip_address: clientIp(req),
                    extra: typeof extra === 'object' ? JSON.stringify(extra) : (extra || ''),
                    received_at: new Date().toISOString(),
                };
                const kafkaTopic = process.env.KAFKA_TOPIC_RAW || 'events.raw';
                await publishEvent(kafkaTopic, eventPayload, deviceId);
                logger.info({ deviceId, topic: kafkaTopic }, 'Event published to Kafka');

                // 8.1) Optional: Directly insert to ClickHouse (Fixed for Windows line endings)
                if (String(process.env.CLICKHOUSE_DIRECT_INSERT).trim() === 'true') {
                    try {
                        await insertEvent(eventPayload);
                        logger.info({ deviceId, shotId }, '🚀 [DIRECT INSERT] Success (Legacy Route)');
                    } catch (chError) {
                        logger.error({ error: chError.message, deviceId }, '❌ [DIRECT INSERT] Failed, but continuing');
                    }
                }
            } catch (kafkaError) {
                logger.error({ error: kafkaError.message, deviceId }, 'Failed to publish to Kafka, but continuing');
            }
        }

        // 9) Lưu metadata JSON kèm ảnh
        const meta = {
            deviceId,
            ts,
            shotId: shotId || null,
            size: file.size,
            mime: file.mimetype || "image/jpeg",
            sha256: sha256(file.buffer),
            receivedAt: new Date().toISOString(),
            ip: clientIp(req),
            minioUrl: minioResult?.url || null,
            minioObjectKey: minioResult?.objectKey || null,
            extra   // có thể là object đã parse, hoặc { raw: "<string>" }
        };
        await fs.writeFile(jsonPath, JSON.stringify(meta, null, 2), "utf8");

        // 10) Cập nhật bộ nhớ
        if (shotId) rememberShot(deviceId, shotId, ts);
        LAST_TS.set(deviceId, ts);

        return res.json({
            ok: true,
            deviceId,
            ts,
            shotId: shotId || null,
            files: {
                jpg: path.relative(cfg.uploadDir, jpgPath).replace(/\\/g, "/"),
                json: path.relative(cfg.uploadDir, jsonPath).replace(/\\/g, "/")
            },
            minio: minioResult ? {
                objectKey: minioResult.objectKey,
                url: minioResult.url
            } : null
        });
    } catch (e) {
        next(e);
    }
};
