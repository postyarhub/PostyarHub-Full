"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUEUE_NAMES = void 0;
exports.getQueue = getQueue;
exports.enqueue = enqueue;
exports.closeQueues = closeQueues;
const connection_js_1 = require("./connection.js");
const env_js_1 = require("../config/env.js");
const logger_js_1 = require("../core/logger.js");
/** Typed queue registry with bounded retention (§108). */
exports.QUEUE_NAMES = ['delivery', 'bot-events', 'ai-jobs', 'notifications', 'maintenance'];
const queues = new Map();
const log = (0, logger_js_1.createLogger)('queue-registry');
function getQueue(name) {
    const existing = queues.get(name);
    if (existing)
        return existing;
    const q = (0, connection_js_1.createQueue)(name);
    q.on('error', (err) => {
        log.error({ queue: name, errorName: err?.name ?? 'Error', errorCode: err?.code ?? null, message: String(err?.message ?? '').slice(0, 240) }, 'queue_error');
    });
    queues.set(name, q);
    return q;
}
const JOB_RETENTION = { removeOnComplete: { age: 24 * 3600, count: 5000 }, removeOnFail: { age: 7 * 24 * 3600, count: 5000 } };
function normalizeJobId(value) {
    if (!value)
        return undefined;
    const normalized = value
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized ? normalized.slice(0, 180) : undefined;
}
async function enqueue(name, jobName, data, opts = {}) {
    const env = (0, env_js_1.loadEnv)();
    if (env.DISABLE_QUEUE) {
        if (env.NODE_ENV === 'production') {
            throw new Error('Background queue is disabled in production.');
        }
        return; // test-mode escape hatch; real deployments always queue
    }
    const safeJobId = opts.jobId?.replace(/:/g, '-');
    await getQueue(name).add(jobName, data, {
        jobId: safeJobId,
        delay: opts.delayMs,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        ...JOB_RETENTION,
    });
}
async function closeQueues() {
    await Promise.all([...queues.values()].map((q) => q.close()));
    queues.clear();
}
