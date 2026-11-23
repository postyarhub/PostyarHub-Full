"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRedis = getRedis;
exports.bullConnection = bullConnection;
exports.closeRedis = closeRedis;
exports.createQueue = createQueue;
exports.createWorker = createWorker;
const bullmq_1 = require("bullmq");
const ioredis_1 = require("ioredis");
const env_js_1 = require("../config/env.js");
/**
 * BullMQ on external Redis (ADR-0004). The app NEVER installs/provisions Redis (§53).
 */
let connection = null;
function getRedis() {
    if (connection)
        return connection;
    const env = (0, env_js_1.loadEnv)();
    connection = new ioredis_1.Redis(env.REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        lazyConnect: false,
    });
    return connection;
}
function bullConnection() {
    return getRedis();
}
async function closeRedis() {
    if (connection) {
        await connection.quit().catch(() => connection?.disconnect());
        connection = null;
    }
}
function createQueue(name) {
    return new bullmq_1.Queue(name, { connection: bullConnection() });
}
function createWorker(name, processor, opts) {
    const env = (0, env_js_1.loadEnv)();
    return new bullmq_1.Worker(name, processor, {
        connection: bullConnection(),
        concurrency: opts.concurrency,
        ...(name === 'delivery'
            ? { limiter: { max: env.DELIVERY_RATE_LIMIT_MAX, duration: env.DELIVERY_RATE_LIMIT_DURATION_MS } }
            : {}),
    });
}
