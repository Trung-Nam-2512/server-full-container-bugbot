const mqtt = require("../services/mqtt.service");
const deviceRegistry = require("../services/device-registry.service");
const eventProcessor = require("../services/mqtt-event-processor.service");

function requireMqtt(req, res) {
    if (process.env.MQTT_ENABLED !== "true") {
        res.status(503).json({ ok: false, error: "mqtt_disabled" });
        return false;
    }
    if (!mqtt.isConnected()) {
        res.status(503).json({ ok: false, error: "mqtt_not_connected" });
        return false;
    }
    return true;
}

// ── Device listing ──────────────────────────────────────────────

async function getDevices(req, res, next) {
    try {
        const devices = deviceRegistry.getAllDevices();
        const counts = deviceRegistry.getDeviceCount();
        res.json({ ok: true, devices, ...counts });
    } catch (e) {
        next(e);
    }
}

async function getDeviceDetail(req, res, next) {
    try {
        const device = deviceRegistry.getDevice(req.params.id);
        if (!device) {
            return res.status(404).json({ ok: false, error: "device_not_found" });
        }
        const events = eventProcessor.getEvents({ deviceId: req.params.id, limit: 30 });
        res.json({ ok: true, device, events });
    } catch (e) {
        next(e);
    }
}

async function getDeviceStatus(req, res, next) {
    try {
        const device = deviceRegistry.getDevice(req.params.id);
        if (!device) {
            return res.status(404).json({ ok: false, error: "device_not_found" });
        }
        res.json({
            ok: true,
            deviceId: device.deviceId,
            online: device.online,
            stale: device.stale,
            lastSeenAt: device.lastSeenAt,
            firmware: device.firmware,
            ip: device.ip,
        });
    } catch (e) {
        next(e);
    }
}

// ── Commands ────────────────────────────────────────────────────

async function capture(req, res, next) {
    try {
        if (!requireMqtt(req, res)) return;
        const sent = mqtt.capture(req.params.id);
        res.json({ ok: true, sent });
    } catch (e) {
        next(e);
    }
}

async function requestStatus(req, res, next) {
    try {
        if (!requireMqtt(req, res)) return;
        const sent = mqtt.requestStatus(req.params.id);
        res.json({ ok: true, sent });
    } catch (e) {
        next(e);
    }
}

async function resetDevice(req, res, next) {
    try {
        if (!requireMqtt(req, res)) return;
        const sent = mqtt.reset(req.params.id);
        res.json({ ok: true, sent });
    } catch (e) {
        next(e);
    }
}

async function restartCamera(req, res, next) {
    try {
        if (!requireMqtt(req, res)) return;
        const sent = mqtt.restartCamera(req.params.id);
        res.json({ ok: true, sent });
    } catch (e) {
        next(e);
    }
}

async function otaCheck(req, res, next) {
    try {
        if (!requireMqtt(req, res)) return;
        const sent = mqtt.otaCheck(req.params.id);
        res.json({ ok: true, sent });
    } catch (e) {
        next(e);
    }
}

async function otaUpdate(req, res, next) {
    try {
        if (!requireMqtt(req, res)) return;
        const sent = mqtt.otaUpdate(req.params.id);
        res.json({ ok: true, sent });
    } catch (e) {
        next(e);
    }
}

async function autoConfig(req, res, next) {
    try {
        if (!requireMqtt(req, res)) return;
        const { enabled, seconds } = req.body;
        const sent = mqtt.setAutoConfig(req.params.id, enabled, seconds);
        res.json({ ok: true, sent });
    } catch (e) {
        next(e);
    }
}

async function broadcastCapture(req, res, next) {
    try {
        if (!requireMqtt(req, res)) return;
        const sent = mqtt.broadcastCapture();
        res.json({ ok: true, sent });
    } catch (e) {
        next(e);
    }
}

// ── Delete ──────────────────────────────────────────────────────

async function deleteDevice(req, res, next) {
    try {
        const device = deviceRegistry.getDevice(req.params.id);
        if (!device) {
            return res.status(404).json({ ok: false, error: "device_not_found" });
        }
        await deviceRegistry.deleteDevice(req.params.id);
        res.json({ ok: true, message: `Device ${req.params.id} deleted` });
    } catch (e) {
        next(e);
    }
}

// ── Events polling ──────────────────────────────────────────────

async function getEvents(req, res, next) {
    try {
        const { since, deviceId, limit } = req.query;
        const events = eventProcessor.getEvents({
            since: since ? Number(since) : undefined,
            deviceId: deviceId || undefined,
            limit: limit ? parseInt(limit, 10) : 50,
        });
        res.json({ ok: true, events, count: events.length, serverTime: Date.now() });
    } catch (e) {
        next(e);
    }
}

async function getLatestEvents(req, res, next) {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
        const events = eventProcessor.getLatestEvents(limit);
        res.json({ ok: true, events, count: events.length, serverTime: Date.now() });
    } catch (e) {
        next(e);
    }
}

// ── Server-Sent Events (SSE) Stream ─────────────────────────────

async function sseEventsStream(req, res) {
    // 1. Send SSE Headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    // 2. Tùy chọn: Gửi ngay mảng data vừa khởi tạo để đồng bộ trạng thái ban đầu
    const initialEvents = eventProcessor.getLatestEvents(20);
    res.write(`data: ${JSON.stringify({ type: 'init', events: initialEvents })}\n\n`);

    // 3. Đăng ký client với Processor
    const removeClient = eventProcessor.addSSEClient(res);

    // 4. Heartbeat (Giữ kết nối không bị timeout bởi proxy/cloud)
    const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
    }, 15000);

    // 5. Lắng nghe sự kiện ngắt kết nối (VD: User đóng tab)
    req.on('close', () => {
        clearInterval(heartbeat);
        removeClient();
    });
}

// ── MQTT connection info ────────────────────────────────────────

async function getMqttStatus(req, res) {
    res.json({
        ok: true,
        connected: mqtt.isConnected(),
        enabled: process.env.MQTT_ENABLED === "true",
    });
}

module.exports = {
    getDevices,
    getDeviceDetail,
    getDeviceStatus,
    capture,
    requestStatus,
    resetDevice,
    restartCamera,
    otaCheck,
    otaUpdate,
    autoConfig,
    broadcastCapture,
    deleteDevice,
    getEvents,
    getLatestEvents,
    getMqttStatus,
    sseEventsStream,
};
