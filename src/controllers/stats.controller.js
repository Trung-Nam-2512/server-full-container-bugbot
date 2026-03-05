/**
 * Stats Controller
 * 
 * Controller cho statistics endpoints.
 * Migrated từ filesystem scan sang ClickHouse queries.
 */

const { logger } = require('../libs/logger');
const { queryEvents, getDeviceStats: getDeviceStatsFromClickHouse, queryAggregations } = require('../libs/clickhouse');
const cache = require('../libs/cache');

/**
 * Get overall statistics
 * GET /api/stats
 */
exports.getStats = async (req, res, next) => {
    try {
        // Check cache first
        const cacheKey = 'stats:overall';
        const cached = cache.get(cacheKey);

        if (cached) {
            logger.debug('Stats served from cache');
            return res.json({
                ok: true,
                ...cached,
                lastUpdate: new Date().toISOString(),
                cached: true,
            });
        }

        // Query từ ClickHouse thay vì filesystem scan
        const stats = await getOverallStats();

        // Cache result (30 seconds)
        cache.set(cacheKey, stats, 30 * 1000);

        res.json({
            ok: true,
            ...stats,
            lastUpdate: new Date().toISOString(),
            cached: false,
        });
    } catch (error) {
        logger.error({ error: error.message }, 'Error getting stats');
        next(error);
    }
};

/**
 * Get statistics for specific device
 * GET /api/stats/device/:deviceId
 */
exports.getDeviceStats = async (req, res, next) => {
    try {
        const { deviceId } = req.params;

        // Check cache first
        const cacheKey = `stats:device:${deviceId}`;
        const cached = cache.get(cacheKey);

        if (cached) {
            logger.debug({ deviceId }, 'Device stats served from cache');
            return res.json({
                ok: true,
                deviceId,
                ...cached,
                cached: true,
            });
        }

        // Query từ ClickHouse
        const stats = await getDeviceStatsFromClickHouse(deviceId);

        // Cache result (30 seconds)
        cache.set(cacheKey, stats, 30 * 1000);

        res.json({
            ok: true,
            deviceId,
            ...stats,
            cached: false,
        });
    } catch (error) {
        logger.error({ error: error.message, deviceId: req.params.deviceId }, 'Error getting device stats');
        next(error);
    }
};

/**
 * Get device list with status
 * GET /api/stats/devices
 */
exports.getDevices = async (req, res, next) => {
    try {
        // Check cache first
        const cacheKey = 'stats:devices';
        const cached = cache.get(cacheKey);

        if (cached) {
            logger.debug('Devices list served from cache');
            return res.json({
                ok: true,
                devices: cached,
                cached: true,
            });
        }

        // Query từ ClickHouse
        const devices = await getDevicesList();

        // Cache result (30 seconds)
        cache.set(cacheKey, devices, 30 * 1000);

        res.json({
            ok: true,
            devices,
            cached: false,
        });
    } catch (error) {
        logger.error({ error: error.message }, 'Error getting devices');
        next(error);
    }
};

/**
 * Get overall statistics từ ClickHouse
 */
async function getOverallStats() {
    const clickhouseLib = require('../libs/clickhouse');

    // isClickHouseHealthy is async, need to await
    const isHealthy = await clickhouseLib.isClickHouseHealthy();
    if (!isHealthy) {
        throw new Error('ClickHouse not connected');
    }

    const clickhouseClient = clickhouseLib.clickhouseClient;

    // Get total images (loại bỏ device test)
    const totalImagesResult = await clickhouseClient.query({
        query: "SELECT COUNT(*) as count FROM iot.events_raw WHERE device_id NOT LIKE '%test%'",
        format: 'JSONEachRow',
    });
    const totalImagesData = await totalImagesResult.json();
    const totalImages = parseInt(totalImagesData[0]?.count || 0, 10);

    // Get total devices (loại bỏ device test)
    const totalDevicesResult = await clickhouseClient.query({
        query: "SELECT uniq(device_id) as count FROM iot.events_raw WHERE device_id NOT LIKE '%test%'",
        format: 'JSONEachRow',
    });
    const totalDevicesData = await totalDevicesResult.json();
    const totalDevices = parseInt(totalDevicesData[0]?.count || 0, 10);

    // Get today's images
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    // Format timestamps cho ClickHouse
    const formatTimestamp = (dt) => {
        const date = dt instanceof Date ? dt : new Date(dt);
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        const seconds = String(date.getUTCSeconds()).padStart(2, '0');
        const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
    };

    const todayImagesResult = await clickhouseClient.query({
        query: `
            SELECT COUNT(*) as count 
            FROM iot.events_raw 
            WHERE device_id NOT LIKE '%test%'
              AND toDate(timestamp) >= toDate({start:DateTime64(3)}) 
              AND toDate(timestamp) < toDate({end:DateTime64(3)})
        `,
        query_params: {
            start: formatTimestamp(today),
            end: formatTimestamp(tomorrow),
        },
        format: 'JSONEachRow',
    });
    const todayImagesData = await todayImagesResult.json();
    const todayImages = parseInt(todayImagesData[0]?.count || 0, 10);

    // Get online devices (devices có events trong 5 phút gần nhất)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const onlineDevicesResult = await clickhouseClient.query({
        query: `
            SELECT uniq(device_id) as count 
            FROM iot.events_raw 
            WHERE device_id NOT LIKE '%test%'
              AND timestamp >= {threshold:DateTime64(3)}
        `,
        query_params: {
            threshold: formatTimestamp(fiveMinutesAgo),
        },
        format: 'JSONEachRow',
    });
    const onlineDevicesData = await onlineDevicesResult.json();
    const onlineDevices = parseInt(onlineDevicesData[0]?.count || 0, 10);

    return {
        totalDevices,
        onlineDevices,
        totalImages,
        todayImages,
    };
}

/**
 * Get devices list với status
 */
async function getDevicesList() {
    const clickhouseLib = require('../libs/clickhouse');

    // isClickHouseHealthy is async, need to await
    const isHealthy = await clickhouseLib.isClickHouseHealthy();
    if (!isHealthy) {
        throw new Error('ClickHouse not connected');
    }

    const clickhouseClient = clickhouseLib.clickhouseClient;

    // Get device stats từ daily stats và recent events (loại bỏ device test)
    const devicesResult = await clickhouseClient.query({
        query: `
            SELECT 
                device_id,
                max(timestamp) as last_seen,
                count(*) as image_count
            FROM iot.events_raw
            WHERE device_id NOT LIKE '%test%'
            GROUP BY device_id
            ORDER BY device_id
        `,
        format: 'JSONEachRow',
    });

    const devicesData = await devicesResult.json();

    // Transform và add status
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

    const devices = devicesData
        .filter(device => {
            // Lọc bỏ các device test (cam-test, cam-test-fixed, hoặc bất kỳ device nào chứa "test")
            return !device.device_id.toLowerCase().includes('test');
        })
        .map(device => {
            const lastSeen = new Date(device.last_seen);
            const timeDiff = Date.now() - lastSeen.getTime();

            let status = 'offline';
            if (timeDiff < 5 * 60 * 1000) { // 5 minutes
                status = 'online';
            } else if (timeDiff < 30 * 60 * 1000) { // 30 minutes
                status = 'warning';
            }

            return {
                id: device.device_id,
                status,
                lastUpdate: device.last_seen,
                imageCount: parseInt(device.image_count || 0, 10),
                autoEnabled: false, // TODO: từ MongoDB config
                intervalSeconds: 30, // TODO: từ MongoDB config
            };
        });

    return devices;
}
