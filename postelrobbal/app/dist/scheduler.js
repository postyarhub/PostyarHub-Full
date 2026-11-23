"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const env_js_1 = require("./config/env.js");
process.title = 'postyar-scheduler';
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const logger_js_1 = require("./core/logger.js");
const connection_js_1 = require("./queue/connection.js");
const ids_js_1 = require("./core/ids.js");
const queues_js_1 = require("./queue/queues.js");
const client_js_1 = require("./db/client.js");
const outbox_js_1 = require("./core/outbox.js");
const dispatcher_js_1 = require("./workers/dispatcher.js");
const scheduler_tick_js_1 = require("./workers/scheduler.tick.js");
async function rotateLogFileIfNeeded(filePath, maxBytes = 5 * 1024 * 1024) {
    try {
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat && stat.size >= maxBytes) {
            const backup = `${filePath}.1`;
            await fs.unlink(backup).catch(() => undefined);
            await fs.rename(filePath, backup).catch(() => undefined);
        }
    }
    catch {
        // Safe fallback: never block tick execution on log rotation
    }
}
/**
 * Scheduler entry — tick model (§126-127): invoked by cron every minute,
 * acquires a Redis lock, claims due work into queues, relays the outbox,
 * exits. Never spawns unbounded processes.
 */
async function main() {
    // Auto-rotate scheduler stdout logs when exceeding 5 MB to prevent disk exhaustion
    await rotateLogFileIfNeeded(path.resolve(__dirname, '../../logs/scheduler.log'));
    await rotateLogFileIfNeeded(path.resolve(process.cwd(), '../logs/scheduler.log'));
    await rotateLogFileIfNeeded(path.resolve(process.cwd(), 'logs/scheduler.log'));
    const env = (0, env_js_1.loadEnv)();
    const log = (0, logger_js_1.createLogger)('scheduler');
    await (0, client_js_1.initializeDbSessions)();
    const redis = (0, connection_js_1.getRedis)();
    const lockValue = `${process.pid}:${(0, ids_js_1.newToken)(16)}`;
    const lock = await redis.set(env.SCHEDULER_LOCK_KEY, lockValue, 'EX', 240, 'NX');
    if (lock !== 'OK') {
        // Another scheduler instance holds the tick — exit quietly (§68).
        await (0, connection_js_1.closeRedis)();
        return;
    }
    let failed = false;
    try {
        const result = await (0, scheduler_tick_js_1.runSchedulerTick)();
        const relayed = await (0, outbox_js_1.relayOutbox)(dispatcher_js_1.outboxDispatcher);
        log.info({ relayed, ...result }, 'scheduler_tick_complete');
    }
    catch (err) {
        failed = true;
        log.error({ err }, 'scheduler_tick_failed');
    }
    finally {
        await (0, queues_js_1.closeQueues)();
        await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, env.SCHEDULER_LOCK_KEY, lockValue).catch(() => undefined);
        await (0, connection_js_1.closeRedis)();
        await (0, client_js_1.closeDb)();
        void client_js_1.getDb; // keep import stable for future in-tick reads
        void queues_js_1.enqueue;
        process.exit(failed ? 1 : 0);
    }
}
main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[scheduler] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
});
