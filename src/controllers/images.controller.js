const fs = require("fs/promises");
const path = require("path");
const cfg = require("../config");
const { logger } = require("../libs/logger");
const imagesService = require("../services/images.service");
const { getMinioClient } = require("../libs/minio");

/**
 * GET /api/cam/images - Get all images với detection data
 */
exports.getImages = async (req, res, next) => {
    try {
        const filters = {
            page: req.query.page || 1,
            limit: req.query.limit || 12,
            search: req.query.search || '',
            deviceId: req.query.deviceId || '',
            startDate: req.query.startDate || '',
            endDate: req.query.endDate || '',
            sortBy: req.query.sortBy || 'timestamp',
            sortOrder: req.query.sortOrder || 'desc',
            hasDetections: req.query.hasDetections,
            minConfidence: req.query.minConfidence,
            species: req.query.species,
        };

        const result = await imagesService.getImages(filters);

        res.json({
            ok: true,
            ...result,
        });
    } catch (error) {
        logger.error({ error: error.message }, 'Error in getImages controller');
        next(error);
    }
};

/**
 * GET /api/cam/images/:id - Get single image với detection data
 */
exports.getImageById = async (req, res, next) => {
    try {
        const { id } = req.params;
        const image = await imagesService.getImageById(id);

        if (!image) {
            return res.status(404).json({ ok: false, error: "Image not found" });
        }

        res.json({ ok: true, image });
    } catch (error) {
        logger.error({ error: error.message, imageId: req.params.id }, 'Error in getImageById controller');
        next(error);
    }
};

// Download image
exports.downloadImage = async (req, res, next) => {
    try {
        const { id } = req.params;
        const images = await getAllImages();
        const image = images.find(img => img.id === id);

        if (!image) {
            return res.status(404).json({ ok: false, error: "Image not found" });
        }

        // Check if file exists
        try {
            await fs.access(image.filePath);
        } catch (err) {
            return res.status(404).json({ ok: false, error: "File not found on disk" });
        }

        res.download(image.filePath, image.filename);
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/cam/images/:id - Delete image
 */
exports.deleteImage = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Gọi service xóa (xử lý cả ClickHouse và MinIO)
        await imagesService.deleteImage(id);

        res.json({ ok: true, message: "Image deleted successfully" });
    } catch (error) {
        if (error.message === 'Image not found') {
            return res.status(404).json({ ok: false, error: "Image not found" });
        }
        logger.error({ error: error.message, imageId: req.params.id }, 'Error in deleteImage controller');
        next(error);
    }
};

/**
 * GET /api/cam/images/:id/annotated - Get annotated image from MinIO
 */
exports.getAnnotatedImage = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Get image data to find annotated URL
        const image = await imagesService.getImageById(id);

        if (!image) {
            return res.status(404).json({ ok: false, error: "Image not found" });
        }

        if (!image.hasDetections || !image.annotatedImageUrl) {
            return res.status(404).json({ ok: false, error: "No annotated image available" });
        }

        // Extract bucket and object path from annotated URL
        // Format: http://minio:9000/iot-annotated/device_id/YYYYMMDD/filename.jpg
        const url = new URL(image.annotatedImageUrl);
        const pathParts = url.pathname.split('/').filter(p => p);
        const bucket = pathParts[0] || 'iot-annotated';
        const objectPath = pathParts.slice(1).join('/');

        // Get MinIO client
        const minioClient = getMinioClient();
        if (!minioClient) {
            logger.error('MinIO client not available');
            return res.status(503).json({ ok: false, error: "Storage service unavailable" });
        }

        // Stream image from MinIO
        const stream = await minioClient.getObject(bucket, objectPath);

        res.setHeader('Content-Type', image.mimeType || 'image/jpeg');
        res.setHeader('Content-Disposition', `inline; filename="${image.filename}"`);

        stream.pipe(res);

        stream.on('error', (error) => {
            logger.error({ error: error.message, bucket, objectPath }, 'Error streaming annotated image');
            if (!res.headersSent) {
                res.status(500).json({ ok: false, error: "Failed to retrieve annotated image" });
            }
        });
    } catch (error) {
        logger.error({ error: error.message, imageId: req.params.id }, 'Error in getAnnotatedImage controller');
        if (!res.headersSent) {
            next(error);
        }
    }
};

/**
 * GET /api/cam/images/:id/serve - Proxy stream ảnh từ MinIO về client (không cần auth)
 */
exports.serveImage = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Lấy image data từ DB để tìm objectKey
        const image = await imagesService.getImageById(id);

        if (!image) {
            return res.status(404).json({ ok: false, error: 'Image not found' });
        }

        // Lấy MinIO client
        const { getMinioClient, BUCKET_NAME } = require('../libs/minio');
        const minioClient = getMinioClient();
        if (!minioClient) {
            return res.status(503).json({ ok: false, error: 'Storage service unavailable' });
        }

        // Trích xuất objectKey từ image_url lưu trong DB
        // Có 3 dạng URL:
        // 1. MinIO Console URL: http://domain/api/v1/buckets/iot-raw/objects/download?prefix=<base64>&...
        // 2. Direct MinIO URL:  http://minio:9000/iot-raw/raw/yyyy/mm/dd/device/file.jpg
        // 3. Path thuần:        raw/yyyy/mm/dd/device/file.jpg
        let objectKey = image.url || '';
        try {
            const urlObj = new URL(objectKey);
            const searchParams = new URLSearchParams(urlObj.search);
            const prefix = searchParams.get('prefix');

            if (prefix && urlObj.pathname.includes('/api/v1/buckets/')) {
                // Dạng MinIO Console URL → decode base64 prefix
                objectKey = Buffer.from(prefix, 'base64').toString('utf8');
                logger.debug({ imageId: id, prefix, objectKey }, 'Decoded MinIO Console URL prefix');
            } else {
                // Dạng direct MinIO URL → bỏ tên bucket ở đầu path
                const parts = urlObj.pathname.split('/').filter(Boolean);
                objectKey = parts.length > 1 ? parts.slice(1).join('/') : parts.join('/');
            }
        } catch {
            // Không phải URL đầy đủ → bỏ bucket prefix nếu có
            objectKey = objectKey.replace(/^\/?iot-raw\//, '');
        }

        logger.debug({ imageId: id, objectKey, bucket: BUCKET_NAME }, 'Serving image from MinIO');

        const stream = await minioClient.getObject(BUCKET_NAME, objectKey);

        res.setHeader('Content-Type', image.mimeType || 'image/jpeg');
        res.setHeader('Content-Disposition', `inline; filename="${image.filename}"`);
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache 1 ngày

        stream.pipe(res);

        stream.on('error', (error) => {
            logger.error({ error: error.message, objectKey, bucket: BUCKET_NAME }, 'Error streaming image');
            if (!res.headersSent) {
                res.status(500).json({ ok: false, error: 'Failed to retrieve image' });
            }
        });
    } catch (error) {
        logger.error({ error: error.message, imageId: req.params.id }, 'Error in serveImage controller');
        if (!res.headersSent) next(error);
    }
};

/**
 * GET /api/cam/images/:id/detections - Get detection details
 */
exports.getDetections = async (req, res, next) => {
    try {
        const { id } = req.params;

        const image = await imagesService.getImageById(id);

        if (!image) {
            return res.status(404).json({ ok: false, error: "Image not found" });
        }

        if (!image.hasDetections) {
            return res.json({
                ok: true,
                imageId: image.id,
                hasDetections: false,
                detections: [],
            });
        }

        res.json({
            ok: true,
            imageId: image.id,
            hasDetections: true,
            detectionCount: image.detectionCount,
            detections: image.detections || [],
            metadata: {
                inferenceModel: image.inferenceModel,
                inferenceVersion: image.inferenceVersion,
                processingTimeMs: image.processingTimeMs,
                processedAt: image.processedAt,
            },
        });
    } catch (error) {
        logger.error({ error: error.message, imageId: req.params.id }, 'Error in getDetections controller');
        next(error);
    }
};

// Helper function to get all images from uploads directory
async function getAllImages() {
    const images = [];
    const uploadDir = cfg.uploadDir;

    try {
        // Get all device directories
        const deviceDirs = await fs.readdir(uploadDir, { withFileTypes: true });

        for (const deviceDir of deviceDirs) {
            if (!deviceDir.isDirectory()) continue;

            const deviceId = deviceDir.name;
            const devicePath = path.join(uploadDir, deviceId);

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

                                // Extract timestamp from filename (format: YYYYMMDD_HHMMSS_deviceId.jpg)
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
                                    deviceId,
                                    url: `/uploads/${deviceId}/${yearDir.name}/${monthDir.name}/${dayDir.name}/${file}`,
                                    filePath,
                                    size: stats.size,
                                    createdAt: timestamp || stats.birthtime,
                                    updatedAt: stats.mtime
                                });
                            }
                        }
                    }
                }
            }
        }

        // Sort by creation date (newest first)
        return images.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch (error) {
        console.error('Error reading images directory:', error);
        return [];
    }
}
