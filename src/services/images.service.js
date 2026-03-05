const fs = require('fs/promises');
const path = require('path');
const cfg = require('../config');
const { logger } = require('../libs/logger');
const { getClickHouseClient } = require('../libs/clickhouse');

/**
 * Get all images với detection data từ ClickHouse
 */
async function getImages(filters = {}) {
    const {
        page = 1,
        limit = 12,
        search = '',
        deviceId = '',
        startDate = '',
        endDate = '',
        sortBy = 'timestamp',
        sortOrder = 'desc',
        hasDetections = null, // true/false - filter by detection status
        minConfidence = null, // 0-1 - minimum confidence threshold
        species = null, // comma-separated species list
    } = filters;

    try {
        const clickhouseClient = getClickHouseClient();
        if (!clickhouseClient) {
            logger.warn('ClickHouse not available, falling back to filesystem only');
            return await getImagesFromFilesystem(filters);
        }

        // Build query conditions
        const conditions = [];
        const query_params = {};

        // Luôn loại bỏ các device test
        conditions.push("r.device_id NOT LIKE '%test%'");

        if (deviceId) {
            conditions.push('r.device_id = {device_id:String}');
            query_params.device_id = deviceId;
        }

        if (startDate && endDate) {
            conditions.push('r.timestamp >= {start_date:DateTime64(3)}');
            conditions.push('r.timestamp <= {end_date:DateTime64(3)}');
            query_params.start_date = formatTimestamp(new Date(startDate));
            query_params.end_date = formatTimestamp(new Date(endDate + 'T23:59:59.999Z'));
        }

        if (hasDetections !== null) {
            if (hasDetections === 'true' || hasDetections === true) {
                conditions.push('e.detection_count > 0');
            } else {
                conditions.push('e.detection_count = 0 OR e.detection_count IS NULL');
            }
        }

        if (minConfidence !== null && !isNaN(minConfidence)) {
            // Filter by minimum confidence - need to parse detections JSON
            conditions.push('length(e.detections) > 0');
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        // Build ORDER BY clause
        let orderByField = 'r.timestamp';
        if (sortBy === 'detections') {
            orderByField = 'e.detection_count';
        } else if (sortBy === 'size') {
            orderByField = 'r.image_size';
        }
        const orderDir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        // Query với pagination
        const offset = (page - 1) * limit;

        const query = `
            SELECT 
                r.device_id,
                r.timestamp,
                r.shot_id,
                r.image_url,
                r.image_size,
                r.image_md5,
                r.mime_type,
                e.annotated_image_url,
                e.detection_count,
                e.detections,
                e.inference_model,
                e.processing_time_ms,
                e.processed_at
            FROM iot.events_raw r
            LEFT JOIN iot.events_enriched e 
                ON r.device_id = e.device_id 
                AND r.shot_id = e.shot_id
            ${whereClause}
            ORDER BY ${orderByField} ${orderDir}
            LIMIT {limit:UInt32} OFFSET {offset:UInt32}
        `;

        query_params.limit = parseInt(limit, 10);
        query_params.offset = parseInt(offset, 10);

        logger.debug({ query, query_params }, 'Querying images with detection data');

        const result = await clickhouseClient.query({
            query,
            query_params,
            format: 'JSONEachRow',
        });

        const rows = await result.json();

        // Post-process results
        const { transformInternalUrlToPublic } = require('../libs/minio');

        let images = rows.map(row => {
            // Transform internal URL to public URL
            const publicUrl = transformInternalUrlToPublic(row.image_url);
            const publicAnnotatedUrl = row.annotated_image_url ? transformInternalUrlToPublic(row.annotated_image_url) : null;

            const image = {
                id: row.shot_id || `${row.device_id}_${new Date(row.timestamp).getTime()}`,
                deviceId: row.device_id,
                filename: path.basename(row.image_url || ''),
                url: publicUrl || row.image_url, // Use transformed URL or fallback to original
                size: parseInt(row.image_size, 10),
                timestamp: row.timestamp,
                md5: row.image_md5,
                mimeType: row.mime_type,
            };

            // Add detection data if available
            if (row.detection_count > 0) {
                image.hasDetections = true;
                image.detectionCount = parseInt(row.detection_count, 10);
                image.annotatedImageUrl = publicAnnotatedUrl || row.annotated_image_url;
                image.inferenceModel = row.inference_model;
                image.processingTimeMs = parseInt(row.processing_time_ms, 10);
                image.processedAt = row.processed_at;

                // Parse detections JSON
                try {
                    image.detections = JSON.parse(row.detections || '[]');
                } catch (e) {
                    logger.warn({ error: e.message, detections: row.detections }, 'Failed to parse detections JSON');
                    image.detections = [];
                }
            } else {
                image.hasDetections = false;
                image.detectionCount = 0;
                image.detections = [];
            }

            return image;
        });

        // Apply additional filters (minConfidence, species, search)
        if (search) {
            images = images.filter(img =>
                img.filename.toLowerCase().includes(search.toLowerCase())
            );
        }

        if (minConfidence !== null && !isNaN(minConfidence)) {
            const threshold = parseFloat(minConfidence);
            images = images.filter(img => {
                if (!img.detections || img.detections.length === 0) return false;
                return img.detections.some(det => det.confidence >= threshold);
            });
        }

        if (species) {
            const speciesList = species.split(',').map(s => s.trim().toLowerCase());
            images = images.filter(img => {
                if (!img.detections || img.detections.length === 0) return false;
                return img.detections.some(det =>
                    speciesList.includes(det.class.toLowerCase())
                );
            });
        }

        // Get total count
        const countQuery = `
            SELECT COUNT(*) as total
            FROM iot.events_raw r
            LEFT JOIN iot.events_enriched e 
                ON r.device_id = e.device_id 
                AND r.shot_id = e.shot_id
            ${whereClause}
        `;

        const countResult = await clickhouseClient.query({
            query: countQuery,
            query_params: Object.fromEntries(
                Object.entries(query_params).filter(([k]) => !['limit', 'offset'].includes(k))
            ),
            format: 'JSONEachRow',
        });

        const countData = await countResult.json();
        const total = parseInt(countData[0]?.total || 0, 10);

        return {
            images,
            total,
            page: parseInt(page, 10),
            limit: parseInt(limit, 10),
            totalPages: Math.ceil(total / limit),
        };
    } catch (error) {
        logger.error({ error: error.message, filters }, 'Failed to get images from ClickHouse');
        // Fallback to filesystem if ClickHouse fails
        return await getImagesFromFilesystem(filters);
    }
}

/**
 * Get single image by ID (shot_id) với detection data
 */
async function getImageById(imageId) {
    try {
        const clickhouseClient = getClickHouseClient();
        if (!clickhouseClient) {
            throw new Error('ClickHouse not available');
        }

        const query = `
            SELECT 
                r.device_id,
                r.timestamp,
                r.shot_id,
                r.image_url,
                r.image_size,
                r.image_md5,
                r.mime_type,
                r.firmware_version,
                r.ip_address,
                e.annotated_image_url,
                e.detection_count,
                e.detections,
                e.inference_model,
                e.inference_version,
                e.processing_time_ms,
                e.processed_at
            FROM iot.events_raw r
            LEFT JOIN iot.events_enriched e 
                ON r.device_id = e.device_id 
                AND r.shot_id = e.shot_id
            WHERE r.shot_id = {image_id:String}
            LIMIT 1
        `;

        const result = await clickhouseClient.query({
            query,
            query_params: { image_id: imageId },
            format: 'JSONEachRow',
        });

        const rows = await result.json();
        if (rows.length === 0) {
            return null;
        }

        const row = rows[0];

        // Transform internal URL to public URL
        const { transformInternalUrlToPublic } = require('../libs/minio');
        const publicUrl = transformInternalUrlToPublic(row.image_url);
        const publicAnnotatedUrl = row.annotated_image_url ? transformInternalUrlToPublic(row.annotated_image_url) : null;

        const image = {
            id: row.shot_id,
            deviceId: row.device_id,
            filename: path.basename(row.image_url || ''),
            url: publicUrl || row.image_url, // Use transformed URL or fallback to original
            size: parseInt(row.image_size, 10),
            timestamp: row.timestamp,
            md5: row.image_md5,
            mimeType: row.mime_type,
            firmwareVersion: row.firmware_version,
            ipAddress: row.ip_address,
        };

        // Add detection data if available
        if (row.detection_count > 0) {
            image.hasDetections = true;
            image.detectionCount = parseInt(row.detection_count, 10);
            image.annotatedImageUrl = publicAnnotatedUrl || row.annotated_image_url;
            image.inferenceModel = row.inference_model;
            image.inferenceVersion = row.inference_version;
            image.processingTimeMs = parseInt(row.processing_time_ms, 10);
            image.processedAt = row.processed_at;

            // Parse detections JSON
            try {
                image.detections = JSON.parse(row.detections || '[]');
            } catch (e) {
                logger.warn({ error: e.message }, 'Failed to parse detections JSON');
                image.detections = [];
            }
        } else {
            image.hasDetections = false;
            image.detectionCount = 0;
            image.detections = [];
        }

        return image;
    } catch (error) {
        logger.error({ error: error.message, imageId }, 'Failed to get image by ID');
        throw error;
    }
}

/**
 * Fallback: Get images from filesystem (legacy)
 */
async function getImagesFromFilesystem(filters = {}) {
    const {
        page = 1,
        limit = 12,
        search = '',
        deviceId = '',
        startDate = '',
        endDate = '',
        sortBy = 'createdAt',
        sortOrder = 'desc',
    } = filters;

    const images = [];
    const uploadDir = cfg.uploadDir;

    try {
        // Get all device directories
        const deviceDirs = await fs.readdir(uploadDir, { withFileTypes: true });

        for (const deviceDir of deviceDirs) {
            if (!deviceDir.isDirectory()) continue;

            const currentDeviceId = deviceDir.name;

            // Lọc bỏ các device test
            if (currentDeviceId.toLowerCase().includes('test')) {
                continue;
            }

            if (deviceId && currentDeviceId !== deviceId) continue;

            const devicePath = path.join(uploadDir, currentDeviceId);

            // Get all year directories
            const yearDirs = await fs.readdir(devicePath, { withFileTypes: true });

            for (const yearDir of yearDirs) {
                if (!yearDir.isDirectory()) continue;

                const yearPath = path.join(devicePath, yearDir.name);
                const monthDirs = await fs.readdir(yearPath, { withFileTypes: true });

                for (const monthDir of monthDirs) {
                    if (!monthDir.isDirectory()) continue;

                    const monthPath = path.join(yearPath, monthDir.name);
                    const dayDirs = await fs.readdir(monthPath, { withFileTypes: true });

                    for (const dayDir of dayDirs) {
                        if (!dayDir.isDirectory()) continue;

                        const dayPath = path.join(monthPath, dayDir.name);
                        const files = await fs.readdir(dayPath);

                        for (const file of files) {
                            if (file.endsWith('.jpg') || file.endsWith('.jpeg')) {
                                const filePath = path.join(dayPath, file);
                                const stats = await fs.stat(filePath);

                                // Extract timestamp from filename
                                const filenameParts = file.split('_');
                                let timestamp = null;

                                if (filenameParts.length >= 3) {
                                    const dateStr = filenameParts[0];
                                    const timeStr = filenameParts[1];
                                    if (dateStr.length === 8 && timeStr.length === 6) {
                                        const year = dateStr.substring(0, 4);
                                        const month = dateStr.substring(4, 6);
                                        const day = dateStr.substring(6, 8);
                                        const hour = timeStr.substring(0, 2);
                                        const minute = timeStr.substring(2, 4);
                                        const second = timeStr.substring(4, 6);
                                        timestamp = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
                                    }
                                }

                                images.push({
                                    id: `img_${images.length + 1}`,
                                    filename: file,
                                    deviceId: currentDeviceId,
                                    url: `/uploads/${currentDeviceId}/${yearDir.name}/${monthDir.name}/${dayDir.name}/${file}`,
                                    filePath,
                                    size: stats.size,
                                    timestamp: timestamp || stats.birthtime,
                                    updatedAt: stats.mtime,
                                    hasDetections: false,
                                    detectionCount: 0,
                                });
                            }
                        }
                    }
                }
            }
        }

        // Apply filters
        let filteredImages = images;

        if (search) {
            filteredImages = filteredImages.filter(img =>
                img.filename.toLowerCase().includes(search.toLowerCase())
            );
        }

        if (startDate && endDate) {
            const start = new Date(startDate);
            const end = new Date(endDate);
            filteredImages = filteredImages.filter(img => {
                const imgDate = new Date(img.timestamp); // Changed from createdAt to timestamp
                return imgDate >= start && imgDate <= end;
            });
        }

        // Sort
        filteredImages.sort((a, b) => {
            let aVal = a[sortBy];
            let bVal = b[sortBy];

            if (sortBy === 'createdAt' || sortBy === 'updatedAt' || sortBy === 'timestamp') { // Added timestamp
                aVal = new Date(aVal).getTime();
                bVal = new Date(bVal).getTime();
            }

            if (sortOrder === 'asc') {
                return aVal > bVal ? 1 : -1;
            } else {
                return aVal < bVal ? 1 : -1;
            }
        });

        // Pagination
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + parseInt(limit, 10);
        const paginatedImages = filteredImages.slice(startIndex, endIndex);

        return {
            images: paginatedImages,
            total: filteredImages.length,
            page: parseInt(page, 10),
            limit: parseInt(limit, 10),
            totalPages: Math.ceil(filteredImages.length / limit),
        };
    } catch (error) {
        logger.error({ error: error.message }, 'Failed to get images from filesystem');
        throw error;
    }
}

/**
 * Format timestamp cho ClickHouse
 */
function formatTimestamp(dt) {
    if (!dt) return null;
    const date = dt instanceof Date ? dt : new Date(dt);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

module.exports = {
    getImages,
    getImageById,
    getImagesFromFilesystem,
};


