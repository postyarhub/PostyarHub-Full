"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runRetentionSweep = runRetentionSweep;
exports.startMaintenanceWorker = startMaintenanceWorker;
exports.enqueueSweep = enqueueSweep;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../db/client.js");
const schema_js_1 = require("../db/schema.js");
const post_aggregate_js_1 = require("../core/post-aggregate.js");
const connection_js_1 = require("../queue/connection.js");
const logger_js_1 = require("../core/logger.js");
const sessions_js_1 = require("../security/sessions.js");
/**
 * Maintenance worker (§106-108): bounded retention sweeps. Every delete runs
 * in batches (LIMIT 1000) with a hard iteration cap so a large backlog can
 * never stall the worker or hold long table locks.
 */
const log = (0, logger_js_1.createLogger)('maintenance-worker');
const BATCH = 1000;
const MAX_ITERATIONS = 20;
const RETENTION_DAYS_EVENTS = 180;
const RETENTION_DAYS_CLICKS = 180;
const RETENTION_DAYS_BOT_EVENTS = 90;
function affectedRowsOf(result) {
    if (Array.isArray(result)) {
        const head = result[0];
        return typeof head?.affectedRows === 'number' ? head.affectedRows : 0;
    }
    const head = result;
    return typeof head?.affectedRows === 'number' ? head.affectedRows : 0;
}
async function batchedDelete(table, where) {
    const db = (0, client_js_1.getDb)();
    let deleted = 0;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
        const res = await db.delete(table).where(where).limit(BATCH);
        const affected = affectedRowsOf(res);
        deleted += affected;
        if (affected < BATCH)
            break;
    }
    return deleted;
}
async function runRetentionSweep() {
    const now = Date.now();
    const db = (0, client_js_1.getDb)();
    const eventsDeleted = await batchedDelete(schema_js_1.events, (0, drizzle_orm_1.lt)(schema_js_1.events.createdAt, new Date(now - RETENTION_DAYS_EVENTS * 86400_000)));
    const clicksDeleted = await batchedDelete(schema_js_1.linkClicks, (0, drizzle_orm_1.lt)(schema_js_1.linkClicks.createdAt, new Date(now - RETENTION_DAYS_CLICKS * 86400_000)));
    const botEventsDeleted = await batchedDelete(schema_js_1.botEvents, (0, drizzle_orm_1.sql) `${schema_js_1.botEvents.state} = 'PROCESSED' AND ${schema_js_1.botEvents.createdAt} < ${new Date(now - RETENTION_DAYS_BOT_EVENTS * 86400_000)}`);
    // Expired transient rows: single bounded pass per sweep.
    await db.delete(schema_js_1.mediaAccessTokens).where((0, drizzle_orm_1.lt)(schema_js_1.mediaAccessTokens.expiresAt, new Date()));
    await db.delete(schema_js_1.idempotencyKeys).where((0, drizzle_orm_1.lt)(schema_js_1.idempotencyKeys.expiresAt, new Date()));
    await (0, sessions_js_1.sweepExpiredSessions)();
    // Safety reaper: external-side-effect jobs that remain PROCESSING for an
    // extended period are marked FAILED rather than auto-requeued. The provider
    // may have accepted the request before a worker crash; automatic replay could
    // create duplicate posts/messages. Manual retry can be an explicit operator
    // action after inspecting the provider state.
    const stuckCutoff = new Date(now - 30 * 60_000);
    const staleDeliveries = await db
        .select({ id: schema_js_1.postTargets.id, postId: schema_js_1.postTargets.postId, postState: schema_js_1.posts.state })
        .from(schema_js_1.postTargets)
        .innerJoin(schema_js_1.posts, (0, drizzle_orm_1.eq)(schema_js_1.posts.id, schema_js_1.postTargets.postId))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'PROCESSING'), (0, drizzle_orm_1.lt)(schema_js_1.postTargets.updatedAt, stuckCutoff)))
        .limit(100);
    let reapedCount = 0;
    for (const target of staleDeliveries) {
        const reaped = await db
            .update(schema_js_1.postTargets)
            .set(target.postState === 'CANCELLED' || target.postState === 'DRAFT'
            ? { state: 'CANCELLED', nextRetryAt: null }
            : {
                state: 'FAILED',
                nextRetryAt: null,
                errorCode: 'WORKER_STALE',
                errorMessage: 'پردازش ارسال بیش از حد طولانی در وضعیت نامشخص مانده است؛ برای جلوگیری از ارسال تکراری، توقف داده شد. قبل از تلاش مجدد مقصد را بررسی کنید.',
            })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, target.id), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'PROCESSING'), (0, drizzle_orm_1.lt)(schema_js_1.postTargets.updatedAt, stuckCutoff)));
        const affected = affectedRowsOf(reaped);
        reapedCount += affected;
        if (affected > 0 && target.postState !== 'CANCELLED' && target.postState !== 'DRAFT') {
            await (0, post_aggregate_js_1.refreshPostAggregate)(target.postId);
        }
    }
    const staleBotEvents = await db
        .select({ id: schema_js_1.botEvents.id })
        .from(schema_js_1.botEvents)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botEvents.state, 'PROCESSING'), (0, drizzle_orm_1.lt)(schema_js_1.botEvents.createdAt, stuckCutoff)))
        .limit(100);
    let botEventsReaped = 0;
    for (const event of staleBotEvents) {
        const result = await db
            .update(schema_js_1.botEvents)
            .set({ state: 'FAILED', processedAt: new Date() })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botEvents.id, event.id), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.state, 'PROCESSING'), (0, drizzle_orm_1.lt)(schema_js_1.botEvents.createdAt, stuckCutoff)));
        botEventsReaped += affectedRowsOf(result);
    }
    const notifCutoff = new Date(now - 30 * 60_000);
    const staleNotificationOutbound = await db
        .select({ id: schema_js_1.notificationOutbound.id })
        .from(schema_js_1.notificationOutbound)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.state, 'PROCESSING'), (0, drizzle_orm_1.lt)(schema_js_1.notificationOutbound.updatedAt, notifCutoff)))
        .limit(100);
    let notificationOutboundReaped = 0;
    for (const row of staleNotificationOutbound) {
        const result = await db
            .update(schema_js_1.notificationOutbound)
            .set({ state: 'FAILED', lastError: 'پردازش اعلان در وضعیت نامشخص بیش از حد طولانی ماند؛ برای جلوگیری از ارسال تکراری، متوقف شد.' })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.id, row.id), (0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.state, 'PROCESSING'), (0, drizzle_orm_1.lt)(schema_js_1.notificationOutbound.updatedAt, notifCutoff)));
        notificationOutboundReaped += affectedRowsOf(result);
    }
    // AI calls are billable external side effects. A worker crash can leave a job
    // RUNNING forever; mark stale runs failed instead of replaying them silently.
    const aiCutoff = new Date(now - 30 * 60_000);
    const staleAiJobs = await db
        .select({ id: schema_js_1.aiJobs.id })
        .from(schema_js_1.aiJobs)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.aiJobs.status, 'RUNNING'), (0, drizzle_orm_1.lt)(schema_js_1.aiJobs.createdAt, aiCutoff)))
        .limit(100);
    let aiJobsReaped = 0;
    for (const row of staleAiJobs) {
        const result = await db
            .update(schema_js_1.aiJobs)
            .set({ status: 'FAILED', errorCode: 'AI_WORKER_STALE', finishedAt: new Date() })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.aiJobs.id, row.id), (0, drizzle_orm_1.eq)(schema_js_1.aiJobs.status, 'RUNNING'), (0, drizzle_orm_1.lt)(schema_js_1.aiJobs.createdAt, aiCutoff)));
        aiJobsReaped += affectedRowsOf(result);
    }
    return {
        events: eventsDeleted,
        linkClicks: clicksDeleted,
        botEvents: botEventsDeleted,
        stuckDeliveriesReaped: reapedCount,
        botEventsReaped,
        notificationOutboundReaped,
        aiJobsReaped,
    };
}
function startMaintenanceWorker() {
    // createWorker's processor parameter resolves to `never` due to a broken
    // conditional type in queue/connection.ts — bridge it without losing typing.
    const processor = async (job) => {
        if (job.name !== 'sweep') {
            log.warn({ jobName: job.name }, 'unknown_maintenance_job');
            return;
        }
        const startedAt = Date.now();
        try {
            const result = await runRetentionSweep();
            log.info({ ...result, durationMs: Date.now() - startedAt }, 'maintenance_sweep_complete');
        }
        catch (err) {
            log.error({ err }, 'maintenance_sweep_failed');
            throw err; // BullMQ retry policy applies
        }
    };
    return (0, connection_js_1.createWorker)('maintenance', processor, { concurrency: 1 });
}
/** Scheduler convenience: enqueue one sweep pass. */
async function enqueueSweep() {
    const { enqueue } = await import('../queue/queues.js');
    await enqueue('maintenance', 'sweep', {});
}
