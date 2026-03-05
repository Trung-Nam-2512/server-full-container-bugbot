/**
 * Detection Statistics Service
 * 
 * Service để tính toán detection statistics từ enriched events trong ClickHouse
 * Phase 3: Dashboard & Alert System
 */

const { logger } = require('../libs/logger');

/**
 * Get overall detection statistics
 */
async function getOverallDetectionStats() {
    // Require ClickHouse lib in function (same pattern as stats.controller.js)
    const clickhouseLib = require('../libs/clickhouse');

    // Check health (async function)
    const isHealthy = await clickhouseLib.isClickHouseHealthy();
    if (!isHealthy) {
        throw new Error('ClickHouse not connected');
    }

    // Get client - use function instead of getter (more reliable)
    let clickhouseClient;
    try {
        clickhouseClient = clickhouseLib.getClickHouseClient();
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to get ClickHouse client');
        throw new Error('ClickHouse client not initialized');
    }

    if (!clickhouseClient || typeof clickhouseClient.query !== 'function') {
        logger.error({ hasClient: !!clickhouseClient, clientType: typeof clickhouseClient }, 'ClickHouse client invalid');
        throw new Error('ClickHouse client invalid - missing query method');
    }

    try {
        // Get total detections (handle empty table)
        const totalDetectionsResult = await clickhouseClient.query({
            query: 'SELECT sum(detection_count) as count FROM iot.events_enriched',
            format: 'JSONEachRow',
        });
        const totalDetectionsData = await totalDetectionsResult.json();
        const totalDetections = parseInt(totalDetectionsData[0]?.count || 0, 10);

        // Get total images processed
        const totalImagesResult = await clickhouseClient.query({
            query: 'SELECT count() as count FROM iot.events_enriched',
            format: 'JSONEachRow',
        });
        const totalImagesData = await totalImagesResult.json();
        const totalImages = parseInt(totalImagesData[0]?.count || 0, 10);

        // Calculate average detections per image
        const avgDetectionsPerImage = totalImages > 0
            ? (totalDetections / totalImages).toFixed(2)
            : 0;

        // Get today's detections
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

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

        const todayDetectionsResult = await clickhouseClient.query({
            query: `
                SELECT sum(detection_count) as count
                FROM iot.events_enriched
                WHERE toDate(toTimeZone(processed_at, 'Asia/Ho_Chi_Minh')) >= toDate(toTimeZone({start:DateTime64(3)}, 'Asia/Ho_Chi_Minh'))
                  AND toDate(toTimeZone(processed_at, 'Asia/Ho_Chi_Minh')) < toDate(toTimeZone({end:DateTime64(3)}, 'Asia/Ho_Chi_Minh'))
            `,
            query_params: {
                start: formatTimestamp(today),
                end: formatTimestamp(tomorrow),
            },
            format: 'JSONEachRow',
        });
        const todayDetectionsData = await todayDetectionsResult.json();
        const todayDetections = parseInt(todayDetectionsData[0]?.count || 0, 10);

        // Get this week's detections
        const weekAgo = new Date(today);
        weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);

        const weekDetectionsResult = await clickhouseClient.query({
            query: `
                SELECT sum(detection_count) as count
                FROM iot.events_enriched
                WHERE processed_at >= {start:DateTime64(3)}
            `,
            query_params: {
                start: formatTimestamp(weekAgo),
            },
            format: 'JSONEachRow',
        });
        const weekDetectionsData = await weekDetectionsResult.json();
        const weekDetections = parseInt(weekDetectionsData[0]?.count || 0, 10);

        return {
            totalDetections,
            totalImages,
            avgDetectionsPerImage: parseFloat(avgDetectionsPerImage),
            detectionsToday: todayDetections,
            detectionsThisWeek: weekDetections,
        };
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to get overall detection stats');
        throw error;
    }
}

/**
 * Get species distribution
 */
async function getSpeciesDistribution(deviceId = null) {
    const clickhouseLib = require('../libs/clickhouse');

    const isHealthy = await clickhouseLib.isClickHouseHealthy();
    if (!isHealthy) {
        throw new Error('ClickHouse not connected');
    }

    // Get client - use function instead of getter
    const clickhouseClient = clickhouseLib.getClickHouseClient();

    try {
        // Query enriched events và parse detections JSON
        // Limit để tránh memory issues
        let query = `
            SELECT 
                device_id,
                detections
            FROM iot.events_enriched
            WHERE detection_count > 0
        `;

        const params = {};
        if (deviceId) {
            query += ' AND device_id = {device_id: String}';
            params.device_id = deviceId;
        }

        query += ' LIMIT 10000'; // Limit để performance

        const result = await clickhouseClient.query({
            query,
            query_params: params,
            format: 'JSONEachRow',
        });

        const data = await result.json();

        // Parse detections JSON và count species
        const speciesCount = {};
        let totalDetections = 0;

        for (const row of data) {
            try {
                const detections = JSON.parse(row.detections || '[]');
                for (const detection of detections) {
                    const species = detection.class || detection.name || 'unknown';
                    speciesCount[species] = (speciesCount[species] || 0) + 1;
                    totalDetections++;
                }
            } catch (error) {
                logger.warn({ error: error.message, row }, 'Failed to parse detections JSON');
            }
        }

        // Convert to array và calculate percentages
        const distribution = Object.entries(speciesCount)
            .map(([species, count]) => ({
                species,
                count,
                percentage: totalDetections > 0
                    ? parseFloat(((count / totalDetections) * 100).toFixed(2))
                    : 0,
            }))
            .sort((a, b) => b.count - a.count); // Sort by count descending

        return {
            distribution,
            totalDetections,
        };
    } catch (error) {
        logger.error({ error: error.message, deviceId }, 'Failed to get species distribution');
        throw error;
    }
}

/**
 * Get confidence score distribution
 */
async function getConfidenceDistribution(deviceId = null) {
    const clickhouseLib = require('../libs/clickhouse');

    const isHealthy = await clickhouseLib.isClickHouseHealthy();
    if (!isHealthy) {
        throw new Error('ClickHouse not connected');
    }

    // Get client - use function instead of getter
    const clickhouseClient = clickhouseLib.getClickHouseClient();

    try {
        // Query enriched events và parse detections JSON
        // Limit để tránh memory issues
        let query = `
            SELECT 
                device_id,
                detections
            FROM iot.events_enriched
            WHERE detection_count > 0
        `;

        const params = {};
        if (deviceId) {
            query += ' AND device_id = {device_id: String}';
            params.device_id = deviceId;
        }

        query += ' LIMIT 10000'; // Limit để performance

        const result = await clickhouseClient.query({
            query,
            query_params: params,
            format: 'JSONEachRow',
        });

        const data = await result.json();

        // Parse detections JSON và extract confidence scores
        const confidenceScores = [];
        const rangeCounts = {
            '0.9-1.0': 0,
            '0.8-0.9': 0,
            '0.7-0.8': 0,
            '0.6-0.7': 0,
            '0.5-0.6': 0,
            '0.0-0.5': 0,
        };

        for (const row of data) {
            try {
                const detections = JSON.parse(row.detections || '[]');
                for (const detection of detections) {
                    const confidence = parseFloat(detection.confidence || detection.conf || 0);
                    if (!isNaN(confidence)) {
                        confidenceScores.push(confidence);

                        // Categorize into ranges
                        if (confidence >= 0.9) rangeCounts['0.9-1.0']++;
                        else if (confidence >= 0.8) rangeCounts['0.8-0.9']++;
                        else if (confidence >= 0.7) rangeCounts['0.7-0.8']++;
                        else if (confidence >= 0.6) rangeCounts['0.6-0.7']++;
                        else if (confidence >= 0.5) rangeCounts['0.5-0.6']++;
                        else rangeCounts['0.0-0.5']++;
                    }
                }
            } catch (error) {
                logger.warn({ error: error.message, row }, 'Failed to parse detections JSON');
            }
        }

        // Calculate statistics
        const avgConfidence = confidenceScores.length > 0
            ? parseFloat((confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length).toFixed(3))
            : 0;

        const minConfidence = confidenceScores.length > 0
            ? parseFloat(Math.min(...confidenceScores).toFixed(3))
            : 0;

        const maxConfidence = confidenceScores.length > 0
            ? parseFloat(Math.max(...confidenceScores).toFixed(3))
            : 0;

        // Convert range counts to array
        const distribution = Object.entries(rangeCounts)
            .map(([range, count]) => ({ range, count }))
            .filter(item => item.count > 0);

        return {
            avgConfidence,
            minConfidence,
            maxConfidence,
            distribution,
            totalDetections: confidenceScores.length,
        };
    } catch (error) {
        logger.error({ error: error.message, deviceId }, 'Failed to get confidence distribution');
        throw error;
    }
}

/**
 * Get detection timeline
 * @param {string} period - 'day', 'week', 'month'
 * @param {string} deviceId - Optional device filter
 */
async function getDetectionTimeline(period = 'day', deviceId = null) {
    const clickhouseLib = require('../libs/clickhouse');

    const isHealthy = await clickhouseLib.isClickHouseHealthy();
    if (!isHealthy) {
        throw new Error('ClickHouse not connected');
    }

    // Get client - use function instead of getter
    const clickhouseClient = clickhouseLib.getClickHouseClient();

    try {
        // Determine date range based on period
        const now = new Date();
        let startDate = new Date();
        let groupBy = 'toDate(processed_at)';

        if (period === 'day') {
            startDate.setUTCDate(startDate.getUTCDate() - 7); // Last 7 days
            groupBy = "toDate(toTimeZone(processed_at, 'Asia/Ho_Chi_Minh'))";
        } else if (period === 'week') {
            startDate.setUTCDate(startDate.getUTCDate() - 56); // Last 8 weeks
            groupBy = "toMonday(toTimeZone(processed_at, 'Asia/Ho_Chi_Minh'))"; // Group by week
        } else if (period === 'month') {
            startDate.setUTCMonth(startDate.getUTCMonth() - 12); // Last 12 months
            groupBy = "toStartOfMonth(toTimeZone(processed_at, 'Asia/Ho_Chi_Minh'))"; // Group by month
        }

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

        let query = `
            SELECT 
                ${groupBy} as date,
                sum(detection_count) as count,
                count() as image_count
            FROM iot.events_enriched
            WHERE processed_at >= {start_date:DateTime64(3)}
        `;

        const params = {
            start_date: formatTimestamp(startDate),
        };

        if (deviceId) {
            query += ' AND device_id = {device_id: String}';
            params.device_id = deviceId;
        }

        query += ` GROUP BY date ORDER BY date ASC`;

        const result = await clickhouseClient.query({
            query,
            query_params: params,
            format: 'JSONEachRow',
        });

        const data = await result.json();

        // Format timeline
        const timeline = data.map(row => ({
            date: row.date,
            detectionCount: parseInt(row.count || 0, 10),
            imageCount: parseInt(row.image_count || 0, 10),
        }));

        return {
            period,
            timeline,
        };
    } catch (error) {
        logger.error({ error: error.message, period, deviceId }, 'Failed to get detection timeline');
        throw error;
    }
}

module.exports = {
    getOverallDetectionStats,
    getSpeciesDistribution,
    getConfidenceDistribution,
    getDetectionTimeline,
};
