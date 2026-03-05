// Load environment variables first
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const http = require("http");
const app = require("./app");
const cfg = require("./config");
const path = require("path");
const { mkdirp } = require("mkdirp");
const { logger } = require("./libs/logger");

// Import infrastructure clients
const { initKafka, disconnectKafka, getKafka } = require("./libs/kafka");
const { initMinIO } = require("./libs/minio");
const { initClickHouse, closeClickHouse } = require("./libs/clickhouse");
const { initMongoDB, closeMongoDB } = require("./libs/mongodb");

// Import MQTT + device management services
const mqtt = require("./services/mqtt.service");
const deviceRegistry = require("./services/device-registry.service");
const eventProcessor = require("./services/mqtt-event-processor.service");
const { getServerIP, getAllIPs } = require("./utils/network");

// Import stream processor
const { startStreamProcessor, stopStreamProcessor } = require("./services/stream-processor.service");
// Import enriched events processor (Phase 3)
const { startEnrichedEventsProcessor, stopEnrichedEventsProcessor } = require("./services/enriched-events-processor.service");

/**
 * Initialize all infrastructure services
 */
async function initInfrastructure() {
    logger.info('Initializing infrastructure services...');

    const results = await Promise.allSettled([
        initKafka(),
        initMinIO(),
        initClickHouse(),
        initMongoDB(),
    ]);

    const [kafka, minio, clickhouse, mongodb] = results.map(r => r.status === 'fulfilled' && r.value);

    if (!kafka || !minio) {
        logger.error('Critical services (Kafka or MinIO) failed to initialize');
        logger.warn('Application will start but upload functionality may be limited');
    }

    if (!mongodb) {
        logger.warn('MongoDB failed to initialize - OLTP features may be limited');
    }

    if (!clickhouse) {
        logger.warn('ClickHouse failed to initialize - analytics features may be limited');
    }

    logger.info({
        kafka: kafka ? '✅' : '❌',
        minio: minio ? '✅' : '❌',
        clickhouse: clickhouse ? '✅' : '❌',
        mongodb: mongodb ? '✅' : '❌',
    }, 'Infrastructure initialization completed');
}

/**
 * Graceful shutdown
 */
async function gracefulShutdown(signal) {
    logger.info({ signal }, 'Received shutdown signal, closing gracefully...');

    try {
        // Stop MQTT + processors
        eventProcessor.stop();
        mqtt.stop();
        await stopStreamProcessor();
        await stopEnrichedEventsProcessor();

        // Close connections
        await Promise.all([
            disconnectKafka(),
            closeClickHouse(),
            closeMongoDB(),
        ]);

        logger.info('All connections closed successfully');
        process.exit(0);
    } catch (error) {
        logger.error({ error: error.message }, 'Error during shutdown');
        process.exit(1);
    }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

/**
 * Start server
 */
(async () => {
    try {
        // Create upload directory
        await mkdirp(cfg.uploadDir);

        // Initialize infrastructure
        await initInfrastructure();

        // Initialize device registry (load from MongoDB)
        await deviceRegistry.init();

        // Start MQTT service + event processor
        if (String(process.env.MQTT_ENABLED).trim() === 'true') {
            mqtt.start();
            eventProcessor.start(mqtt, deviceRegistry);
            logger.info('MQTT service + event processor started');
        }

        // Start stream processor if enabled
        if (String(process.env.STREAM_PROCESSOR_ENABLED).trim() !== 'false') {
            const kafka = getKafka();
            if (kafka) {
                try {
                    await startStreamProcessor(kafka);
                    logger.info('✅ Stream processor started');
                } catch (error) {
                    logger.error({ error: error.message }, '⚠️ Stream processor failed to start, continuing without it');
                }
            } else {
                logger.warn('⚠️ Kafka not available, stream processor not started');
            }
        }

        // Start enriched events processor if enabled (Phase 3)
        if (String(process.env.ENRICHED_EVENTS_PROCESSOR_ENABLED).trim() !== 'false') {
            const kafka = getKafka();
            if (kafka) {
                try {
                    await startEnrichedEventsProcessor(kafka);
                    logger.info('✅ Enriched events processor started');
                } catch (error) {
                    logger.error({ error: error.message }, '⚠️ Enriched events processor failed to start, continuing without it');
                }
            } else {
                logger.warn('⚠️ Kafka not available, enriched events processor not started');
            }
        }

        // Create HTTP server
        const server = http.createServer(app);

        server.listen(cfg.port, () => {
            const serverIP = getServerIP();
            const allIPs = getAllIPs();

            logger.info('🚀 Server started successfully');
            logger.info(`   Primary: http://${serverIP}:${cfg.port}`);

            if (allIPs.length > 1) {
                allIPs.forEach(ip => {
                    logger.info(`   Network: http://${ip.address}:${cfg.port} (${ip.interface})`);
                });
            }

            logger.info(`📁 Uploads dir: ${path.resolve(cfg.uploadDir)}`);
            logger.info(`📊 Architecture: Streaming-First (Kafka + MinIO + ClickHouse + MongoDB)`);
            logger.info(`🔗 Health check: http://${serverIP}:${cfg.port}/api/health`);
        });
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack }, 'Failed to start server');
        process.exit(1);
    }
})();
