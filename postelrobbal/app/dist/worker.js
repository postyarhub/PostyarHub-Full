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
process.title = 'postyar-worker';
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const logger_js_1 = require("./core/logger.js");
const connection_js_1 = require("./queue/connection.js");
const queues_js_1 = require("./queue/queues.js");
const client_js_1 = require("./db/client.js");
const delivery_worker_js_1 = require("./workers/delivery.worker.js");
const botEvent_worker_js_1 = require("./workers/botEvent.worker.js");
const ai_worker_js_1 = require("./workers/ai.worker.js");
const notification_worker_js_1 = require("./workers/notification.worker.js");
const maintenance_worker_js_1 = require("./workers/maintenance.worker.js");
const botPolling_worker_js_1 = require("./workers/botPolling.worker.js");
const scheduler_tick_js_1 = require("./workers/scheduler.tick.js");
const outbox_js_1 = require("./core/outbox.js");
const dispatcher_js_1 = require("./workers/dispatcher.js");
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
        // Non-blocking log rotation
    }
}
/**
 * Worker entry — single instance. Delivery recovery is also driven here every
 * 30 seconds so scheduled posts and due retries cannot remain stranded when a
 * cron scheduler tick is delayed or unavailable. All recovery transitions are
 * guarded in the database, so the worker and scheduler can safely overlap.
 */
async function main() {
    await rotateLogFileIfNeeded(path.resolve(__dirname, '../../logs/worker.log'));
    await rotateLogFileIfNeeded(path.resolve(process.cwd(), '../logs/worker.log'));
    await rotateLogFileIfNeeded(path.resolve(process.cwd(), 'logs/worker.log'));
    const env = (0, env_js_1.loadEnv)();
    const log = (0, logger_js_1.createLogger)('worker');
    await (0, client_js_1.initializeDbSessions)();
    await (0, connection_js_1.getRedis)().ping();
    const workers = [
        (0, delivery_worker_js_1.startDeliveryWorker)(),
        (0, botEvent_worker_js_1.startBotEventWorker)(),
        (0, ai_worker_js_1.startAiWorker)(),
        (0, notification_worker_js_1.startNotificationWorker)(),
        (0, maintenance_worker_js_1.startMaintenanceWorker)(),
        (0, botPolling_worker_js_1.startBotPollingWorker)(),
    ];
    let recoveryRunning = false;
    const runRecovery = async (reason) => {
        if (recoveryRunning)
            return;
        recoveryRunning = true;
        try {
            const recovery = await (0, scheduler_tick_js_1.runDeliveryRecoveryTick)();
            const relayed = await (0, outbox_js_1.relayOutbox)(dispatcher_js_1.outboxDispatcher);
            if (recovery.scheduledPosts || recovery.retries || recovery.pendingRecoveries || relayed) {
                log.info({ reason, ...recovery, relayed }, 'delivery_recovery_tick_complete');
            }
        }
        catch (err) {
            log.error({ err, reason }, 'delivery_recovery_tick_failed');
        }
        finally {
            recoveryRunning = false;
        }
    };
    await runRecovery('startup');
    const recoveryTimer = setInterval(() => { void runRecovery('interval'); }, 30_000);
    recoveryTimer.unref();
    const shutdown = async (signal) => {
        clearInterval(recoveryTimer);
        log.info({ signal }, 'worker_shutdown_begin');
        try {
            await Promise.all(workers.map((w) => w.close()));
            await (0, queues_js_1.closeQueues)();
            await (0, connection_js_1.closeRedis)();
            await (0, client_js_1.closeDb)();
            log.info('worker_shutdown_complete');
            process.exit(0);
        }
        catch (err) {
            log.error({ err }, 'worker_shutdown_error');
            process.exit(1);
        }
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    log.info({ concurrency: env.WORKER_CONCURRENCY, recoveryIntervalSeconds: 30 }, 'worker_started');
}
main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[worker] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
});
