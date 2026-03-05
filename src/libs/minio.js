const Minio = require('minio');
const { logger } = require('./logger');
const crypto = require('crypto');

let minioClient;
let isConnected = false;

const BUCKET_NAME = process.env.MINIO_BUCKET || 'iot-raw';

/**
 * Initialize MinIO client
 */
async function initMinIO() {
    try {
        minioClient = new Minio.Client({
            endPoint: process.env.MINIO_ENDPOINT || 'localhost',
            port: parseInt(process.env.MINIO_PORT) || 1442,
            useSSL: process.env.MINIO_USE_SSL === 'true',
            accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
            secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin123',
        });

        // Check if bucket exists, create if not
        const exists = await minioClient.bucketExists(BUCKET_NAME);
        if (!exists) {
            await minioClient.makeBucket(BUCKET_NAME, 'us-east-1');
            logger.info({ bucket: BUCKET_NAME }, 'MinIO bucket created');
        }

        isConnected = true;
        logger.info({ endpoint: process.env.MINIO_ENDPOINT, bucket: BUCKET_NAME }, '✅ MinIO client initialized');
        return true;
    } catch (error) {
        logger.error({ error: error.message }, '❌ Failed to initialize MinIO');
        return false;
    }
}

/**
 * Generate object key path for image
 * Format: raw/yyyy/mm/dd/deviceId/timestamp_shotId.jpg
 * @param {string} deviceId
 * @param {Date} timestamp
 * @param {string} shotId
 */
function generateObjectKey(deviceId, timestamp, shotId = 'na') {
    const date = new Date(timestamp);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');

    const ts = Date.now();
    const shortShot = shotId ? shotId.slice(-6) : 'na';

    return `raw/${yyyy}/${mm}/${dd}/${deviceId}/${ts}_${shortShot}.jpg`;
}

/**
 * Upload image buffer to MinIO
 * @param {Buffer} imageBuffer - Image data
 * @param {string} deviceId - Device identifier
 * @param {Date} timestamp - Image timestamp
 * @param {string} shotId - Shot identifier
 * @param {string} mimeType - MIME type (default: image/jpeg)
 * @returns {Promise<{objectKey: string, url: string, md5: string, size: number}>}
 */
async function uploadImage(imageBuffer, deviceId, timestamp, shotId = 'na', mimeType = 'image/jpeg') {
    if (!isConnected) {
        throw new Error('MinIO client not initialized');
    }

    try {
        const objectKey = generateObjectKey(deviceId, timestamp, shotId);
        const md5 = crypto.createHash('md5').update(imageBuffer).digest('hex');

        const metadata = {
            'Content-Type': mimeType,
            'X-Device-Id': deviceId,
            'X-Shot-Id': shotId,
            'X-MD5': md5,
            'X-Upload-Time': new Date().toISOString(),
        };

        await minioClient.putObject(
            BUCKET_NAME,
            objectKey,
            imageBuffer,
            imageBuffer.length,
            metadata
        );

        // Generate public URL
        const url = await getObjectUrl(objectKey);

        logger.debug({ objectKey, size: imageBuffer.length, md5 }, 'Image uploaded to MinIO');

        return {
            objectKey,
            url,
            md5,
            size: imageBuffer.length,
        };
    } catch (error) {
        logger.error({ error: error.message, deviceId }, 'Failed to upload image to MinIO');
        throw error;
    }
}

/**
 * Convert object key to base64 encoded prefix (for MinIO Console API)
 * @param {string} objectKey
 * @returns {string}
 */
function encodeObjectKeyToPrefix(objectKey) {
    return Buffer.from(objectKey).toString('base64');
}

/**
 * Get public URL for object using MinIO Console API format
 * @param {string} objectKey
 * @returns {string}
 */
function getPublicObjectUrl(objectKey) {
    const publicDomain = process.env.MINIO_PUBLIC_DOMAIN || process.env.MINIO_PUBLIC_ENDPOINT;

    if (publicDomain) {
        // Use MinIO Console API format
        const prefix = encodeObjectKeyToPrefix(objectKey);
        const protocol = process.env.MINIO_USE_SSL === 'true' || publicDomain.startsWith('https://') ? 'https' : 'http';
        const domain = publicDomain.replace(/^https?:\/\//, ''); // Remove protocol if present

        return `${protocol}://${domain}/api/v1/buckets/${BUCKET_NAME}/objects/download?preview=true&prefix=${prefix}&version_id=null`;
    }

    // Fallback: use presigned URL or direct URL
    return null;
}

/**
 * Get presigned URL for object (7 days expiry)
 * @param {string} objectKey
 * @returns {Promise<string>}
 */
async function getObjectUrl(objectKey, expirySeconds = 7 * 24 * 60 * 60) {
    // Try to use public domain first (MinIO Console API format)
    const publicUrl = getPublicObjectUrl(objectKey);
    if (publicUrl) {
        return publicUrl;
    }

    // Fallback: use presigned URL
    try {
        const url = await minioClient.presignedGetObject(BUCKET_NAME, objectKey, expirySeconds);
        // Transform internal URL to public URL if needed
        return transformInternalUrlToPublic(url);
    } catch (error) {
        logger.error({ error: error.message, objectKey }, 'Failed to generate presigned URL');
        // Return a direct URL as fallback
        const endpoint = process.env.MINIO_PUBLIC_ENDPOINT || process.env.MINIO_ENDPOINT || 'localhost';
        const port = process.env.MINIO_PORT || '1442';
        const protocol = process.env.MINIO_USE_SSL === 'true' ? 'https' : 'http';
        return `${protocol}://${endpoint}:${port}/${BUCKET_NAME}/${objectKey}`;
    }
}

/**
 * Transform internal MinIO URL to public URL
 * @param {string} url - Internal URL (e.g., http://minio:9000/...)
 * @returns {string}
 */
function transformInternalUrlToPublic(url) {
    if (!url) return url;

    const publicDomain = process.env.MINIO_PUBLIC_DOMAIN || process.env.MINIO_PUBLIC_ENDPOINT;

    // If URL contains internal endpoint, transform it
    if (url.includes('minio:9000') || url.includes('localhost:9000') || url.includes('127.0.0.1:9000')) {
        if (publicDomain) {
            try {
                // Extract object key from URL
                // Handle both direct URLs and presigned URLs
                let urlToParse = url;

                // If URL has query params, parse them separately
                const urlParts = url.split('?');
                urlToParse = urlParts[0]; // Use path part only

                const urlObj = new URL(urlToParse);
                const pathParts = urlObj.pathname.split('/').filter(p => p);
                const bucketIndex = pathParts.indexOf(BUCKET_NAME);

                if (bucketIndex >= 0 && bucketIndex < pathParts.length - 1) {
                    const objectKey = pathParts.slice(bucketIndex + 1).join('/');
                    // Object key should not contain query params (already removed above)
                    const publicUrl = getPublicObjectUrl(objectKey);
                    if (publicUrl) {
                        return publicUrl;
                    }
                }
            } catch (error) {
                logger.warn({ error: error.message, url }, 'Failed to parse URL for transformation');
            }
        }

        // Fallback: replace internal endpoint with public endpoint
        const publicEndpoint = process.env.MINIO_PUBLIC_ENDPOINT || 'localhost';
        const publicPort = process.env.MINIO_PORT || '1442';
        const protocol = process.env.MINIO_USE_SSL === 'true' ? 'https' : 'http';

        // Remove query params for fallback (presigned URLs won't work with different domain)
        const urlWithoutQuery = url.split('?')[0];
        return urlWithoutQuery
            .replace(/https?:\/\/minio:9000/, `${protocol}://${publicEndpoint}:${publicPort}`)
            .replace(/https?:\/\/localhost:9000/, `${protocol}://${publicEndpoint}:${publicPort}`)
            .replace(/https?:\/\/127\.0\.0\.1:9000/, `${protocol}://${publicEndpoint}:${publicPort}`);
    }

    return url;
}

/**
 * Extract object key from URL
 * @param {string} url - Either a full URL or a relative path
 * @param {string} bucket - Bucket name
 * @returns {string} - Extracted object key
 */
function extractObjectKey(url, bucket = BUCKET_NAME) {
    if (!url) return '';

    try {
        const urlObj = new URL(url);
        const searchParams = new URLSearchParams(urlObj.search);
        const prefix = searchParams.get('prefix');

        if (prefix && urlObj.pathname.includes('/api/v1/buckets/')) {
            // MinIO Console URL format -> decode base64 prefix
            return Buffer.from(prefix, 'base64').toString('utf8');
        } else {
            // Direct URL format -> remove bucket name from path
            const parts = urlObj.pathname.split('/').filter(Boolean);
            const bucketIndex = parts.indexOf(bucket);
            if (bucketIndex !== -1) {
                return parts.slice(bucketIndex + 1).join('/');
            }
            return parts.join('/');
        }
    } catch {
        // Not a full URL -> already a path, just remove leading bucket if present
        const bucketPrefix = new RegExp(`^\\/?${bucket}\\/`);
        return url.replace(bucketPrefix, '').replace(/^\//, '');
    }
}

/**
 * Delete object from MinIO
 * @param {string} objectKey
 * @param {string} bucket - Bucket name (optional, defaults to BUCKET_NAME)
 */
async function deleteObject(objectKey, bucket = BUCKET_NAME) {
    if (!objectKey) return true;
    try {
        await minioClient.removeObject(bucket, objectKey);
        logger.debug({ bucket, objectKey }, 'Object deleted from MinIO');
        return true;
    } catch (error) {
        logger.error({ error: error.message, bucket, objectKey }, 'Failed to delete object from MinIO');
        return false;
    }
}

/**
 * Health check for MinIO connection
 */
async function isMinIOHealthy() {
    if (!isConnected) return false;

    try {
        await minioClient.bucketExists(BUCKET_NAME);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    initMinIO,
    uploadImage,
    getObjectUrl,
    getPublicObjectUrl,
    transformInternalUrlToPublic,
    extractObjectKey,
    deleteObject,
    isMinIOHealthy,
    getMinioClient: () => minioClient,
    BUCKET_NAME,
};

