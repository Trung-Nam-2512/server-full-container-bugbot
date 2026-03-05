const crypto = require('crypto');
const { uploadImage } = require('../libs/minio');
const { publishEvent } = require('../libs/kafka');
const { insertEvent } = require('../libs/clickhouse');
const { logActivity, updateDeviceLastSeen } = require('../libs/mongodb');
const { safeValidateEventRaw } = require('../schemas/eventRaw.schema');
const { logger } = require('../libs/logger');

// In-memory de-dup & stale guard
const SEEN = new Map();
const LAST_TS = new Map();
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
let FIFO = [];

function nowMs() {
    return Date.now();
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function md5(buf) {
    return crypto.createHash('md5').update(buf).digest('hex');
}

function hmacSha256(key, msg) {
    return crypto.createHmac('sha256', key).update(msg).digest('hex');
}

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
    if (nowMs() - v.at > DEDUP_TTL_MS) {
        SEEN.delete(key);
        return false;
    }
    return true;
}

function clientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || '';
}

/**
 * Parse timestamp from various formats
 * @param {number|string} ts
 * @returns {Date}
 */
function parseTimestamp(ts) {
    const tsStr = String(ts);

    if (tsStr.length === 14) {
        // Format: YYYYMMDDHHMMSS
        const year = tsStr.substring(0, 4);
        const month = tsStr.substring(4, 6);
        const day = tsStr.substring(6, 8);
        const hour = tsStr.substring(8, 10);
        const minute = tsStr.substring(10, 12);
        const second = tsStr.substring(12, 14);
        return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
    } else if (ts > 1000000000000) {
        // Timestamp in milliseconds
        return new Date(ts);
    } else if (ts > 1000000000) {
        // Timestamp in seconds
        return new Date(ts * 1000);
    } else {
        // Fallback to current time
        return new Date();
    }
}

/**
 * Process image upload with streaming architecture
 * @param {object} params
 * @param {Buffer} params.fileBuffer - Image buffer
 * @param {string} params.deviceId - Device identifier
 * @param {number} params.ts - Timestamp
 * @param {string} params.shotId - Shot identifier
 * @param {string} params.signature - HMAC signature (optional)
 * @param {string} params.extraRaw - Extra metadata JSON string
 * @param {string} params.mimetype - MIME type
 * @param {string} params.ipAddress - Client IP address
 * @returns {Promise<object>}
 */
async function processUpload({
    fileBuffer,
    deviceId,
    ts,
    shotId = '',
    signature = '',
    extraRaw = '',
    mimetype = 'image/jpeg',
    ipAddress = '',
    firmwareVersion = 'unknown',
}) {
    const startTime = Date.now();

    try {
        // 1. Verify HMAC signature if secret is configured
        if (process.env.HMAC_SECRET && signature) {
            const hash = sha256(fileBuffer);
            const message = `${deviceId}.${ts}.${hash}`;
            const expected = hmacSha256(process.env.HMAC_SECRET, message);

            if (signature.toLowerCase() !== expected.toLowerCase()) {
                const error = new Error('Invalid signature');
                error.status = 401;
                throw error;
            }
        }

        // 2. De-duplication check
        if (shotId && seenShot(deviceId, shotId)) {
            logger.info({ deviceId, shotId }, 'Duplicate shot detected, skipping');
            return {
                ok: true,
                duplicate: true,
                deviceId,
                shotId,
            };
        }

        // 3. Stale image check (latest-only)
        const lastTs = LAST_TS.get(deviceId) || 0;
        if (ts <= lastTs) {
            logger.info({ deviceId, ts, lastTs }, 'Stale image detected, skipping');
            return {
                ok: true,
                stale: true,
                deviceId,
                ts,
            };
        }

        // 4. Parse extra metadata
        let extra = {};
        if (typeof extraRaw === 'string' && extraRaw.length) {
            try {
                extra = JSON.parse(extraRaw);
            } catch {
                extra = { raw: extraRaw };
            }
        }

        // 5. Upload image to MinIO
        const timestamp = parseTimestamp(ts);
        const minioResult = await uploadImage(
            fileBuffer,
            deviceId,
            timestamp,
            shotId,
            mimetype
        );

        logger.info(
            {
                deviceId,
                shotId,
                size: minioResult.size,
                objectKey: minioResult.objectKey,
            },
            'Image uploaded to MinIO'
        );

        // 6. Prepare event payload for Kafka
        const eventPayload = {
            device_id: deviceId,
            timestamp: timestamp.toISOString(),
            shot_id: shotId || '',
            image_url: minioResult.url,
            image_size: minioResult.size,
            image_md5: minioResult.md5,
            mime_type: mimetype,
            firmware_version: firmwareVersion,
            ip_address: ipAddress,
            extra: JSON.stringify(extra),
            received_at: new Date().toISOString(),
        };

        // 7. Validate event payload
        const validation = safeValidateEventRaw(eventPayload);
        if (!validation.success) {
            logger.warn({ error: validation.error }, 'Event validation failed, but continuing');
        }

        // 8. Publish event to Kafka topic 'events.raw'
        const kafkaTopic = process.env.KAFKA_TOPIC_RAW || 'events.raw';
        await publishEvent(kafkaTopic, eventPayload, deviceId);

        logger.info({ deviceId, topic: kafkaTopic }, 'Event published to Kafka');

        // 9. Optional: Directly insert to ClickHouse (or let Spark handle it)
        if (String(process.env.CLICKHOUSE_DIRECT_INSERT).trim() === 'true') {
            try {
                await insertEvent(eventPayload);
                logger.info({ deviceId, shotId }, '🚀 [DIRECT INSERT] Event inserted to ClickHouse');
            } catch (error) {
                logger.error({ error: error.message }, '❌ [DIRECT INSERT] Failed to insert to ClickHouse, but continuing');
            }
        }

        // 10. Update MongoDB: log activity and update device last seen
        try {
            await Promise.all([
                logActivity(deviceId, 'image_uploaded', {
                    shotId,
                    imageUrl: minioResult.url,
                    size: minioResult.size,
                    md5: minioResult.md5,
                }),
                updateDeviceLastSeen(deviceId),
            ]);
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to update MongoDB, but continuing');
        }

        // 11. Update in-memory cache
        if (shotId) rememberShot(deviceId, shotId, ts);
        LAST_TS.set(deviceId, ts);

        const processingTime = Date.now() - startTime;
        logger.info(
            {
                deviceId,
                processingTime,
                size: minioResult.size,
            },
            'Upload processing completed'
        );

        // 12. Return response
        return {
            ok: true,
            deviceId,
            ts,
            shotId: shotId || null,
            imageUrl: minioResult.url,
            objectKey: minioResult.objectKey,
            md5: minioResult.md5,
            size: minioResult.size,
            published: true,
            processingTime,
        };
    } catch (error) {
        logger.error(
            {
                error: error.message,
                stack: error.stack,
                deviceId,
            },
            'Upload processing failed'
        );
        throw error;
    }
}

module.exports = {
    processUpload,
};

