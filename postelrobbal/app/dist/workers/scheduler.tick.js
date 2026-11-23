"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDeliveryRecoveryTick = runDeliveryRecoveryTick;
exports.runSchedulerTick = runSchedulerTick;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../db/client.js");
const schema_js_1 = require("../db/schema.js");
const outbox_js_1 = require("../core/outbox.js");
const queues_js_1 = require("../queue/queues.js");
const events_js_1 = require("../core/events.js");
const logger_js_1 = require("../core/logger.js");
const delivery_js_1 = require("../modules/notifications/delivery.js");
const post_aggregate_js_1 = require("../core/post-aggregate.js");
const gold_service_js_1 = require("../modules/gold/gold.service.js");
const campaign_service_js_1 = require("../modules/wordpress/campaign.service.js");
const sessions_js_1 = require("../security/sessions.js");
/**
 * Scheduler tick (§126-127): claim due work into queues, then exit. Every
 * section is bounded (LIMIT 500) and idempotent — state flips are guarded by
 * a WHERE clause so a re-run tick can never double-claim.
 */
const log = (0, logger_js_1.createLogger)('scheduler-tick');
const SECTION_LIMIT = 500;
function affectedRowsOf(result) {
    if (Array.isArray(result)) {
        const head = result[0];
        return typeof head?.affectedRows === 'number' ? head.affectedRows : 0;
    }
    const head = result;
    return typeof head?.affectedRows === 'number' ? head.affectedRows : 0;
}
/**
 * Delivery-lane recovery is independent from maintenance-heavy scheduler work.
 * The worker runs it every 30 seconds as a safety net; the scheduler runs it
 * once per minute as the normal clock. Every state transition is conditional
 * so overlapping ticks converge without double-claiming.
 */
async function runDeliveryRecoveryTick(now = new Date()) {
    const db = (0, client_js_1.getDb)();
    let scheduledPosts = 0;
    let retries = 0;
    let pendingRecoveries = 0;
    // Due scheduled posts → QUEUED + outbox row (relayed to per-target jobs).
    const duePosts = await db
        .select({ id: schema_js_1.posts.id })
        .from(schema_js_1.posts)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.state, 'SCHEDULED'), (0, drizzle_orm_1.lte)(schema_js_1.posts.scheduledAt, now)))
        .limit(SECTION_LIMIT);
    for (const due of duePosts) {
        await db.transaction(async (tx) => {
            const flipped = await tx
                .update(schema_js_1.posts)
                .set({ state: 'QUEUED' })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, due.id), (0, drizzle_orm_1.eq)(schema_js_1.posts.state, 'SCHEDULED')));
            if (affectedRowsOf(flipped) === 0)
                return false;
            await tx.insert(schema_js_1.outboxEvents).values((0, outbox_js_1.outboxRow)({ aggregateType: 'post', aggregateId: due.id, eventType: 'post.publish', payload: {} }));
            return true;
        }).then(async (claimed) => {
            if (claimed) {
                scheduledPosts++;
                // If every scheduled destination was already SENT, there is no delivery
                // work to queue; restore the aggregate instead of leaving QUEUED forever.
                const [pendingTarget] = await db
                    .select({ id: schema_js_1.postTargets.id })
                    .from(schema_js_1.postTargets)
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.postId, due.id), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'PENDING')))
                    .limit(1);
                if (!pendingTarget)
                    await (0, post_aggregate_js_1.refreshPostAggregate)(due.id);
            }
        });
    }
    // Recovery lane: every tick re-enqueues undelivered targets of queued or
    // partially-started posts. This is deliberately DB-driven, so an interrupted
    // Redis enqueue/outbox relay cannot strand a post in «در انتظار ارسال».
    const queuedTargets = await db
        .select({ id: schema_js_1.postTargets.id, updatedAt: schema_js_1.postTargets.updatedAt })
        .from(schema_js_1.postTargets)
        .innerJoin(schema_js_1.posts, (0, drizzle_orm_1.eq)(schema_js_1.posts.id, schema_js_1.postTargets.postId))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.inArray)(schema_js_1.posts.state, ['QUEUED', 'PUBLISHING', 'PARTIAL']), (0, drizzle_orm_1.inArray)(schema_js_1.postTargets.state, ['PENDING'])))
        .limit(SECTION_LIMIT);
    for (const target of queuedTargets) {
        try {
            await (0, queues_js_1.enqueue)('delivery', 'deliver', { targetId: target.id }, { jobId: `recover:${target.id}:${target.updatedAt.getTime()}` });
            pendingRecoveries++;
        }
        catch (err) {
            log.warn({ err, targetId: target.id }, 'pending_delivery_enqueue_failed');
        }
    }
    // Due retries → PENDING + immediate delivery job.
    const dueRetries = await db
        .select({ id: schema_js_1.postTargets.id, postId: schema_js_1.postTargets.postId, postState: schema_js_1.posts.state })
        .from(schema_js_1.postTargets)
        .innerJoin(schema_js_1.posts, (0, drizzle_orm_1.eq)(schema_js_1.posts.id, schema_js_1.postTargets.postId))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'RETRYING'), (0, drizzle_orm_1.or)((0, drizzle_orm_1.isNull)(schema_js_1.postTargets.nextRetryAt), (0, drizzle_orm_1.lte)(schema_js_1.postTargets.nextRetryAt, now))))
        .limit(SECTION_LIMIT);
    for (const target of dueRetries) {
        if (target.postState === 'CANCELLED' || target.postState === 'DRAFT') {
            const cancelled = await db
                .update(schema_js_1.postTargets)
                .set({ state: 'CANCELLED', nextRetryAt: null })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, target.id), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'RETRYING')));
            if (affectedRowsOf(cancelled) > 0)
                await (0, post_aggregate_js_1.refreshPostAggregate)(target.postId);
            continue;
        }
        const claimed = await db
            .update(schema_js_1.postTargets)
            .set({ state: 'PENDING' })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, target.id), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'RETRYING')));
        if (affectedRowsOf(claimed) > 0) {
            try {
                await (0, queues_js_1.enqueue)('delivery', 'deliver', { targetId: target.id }, { jobId: `retry:${target.id}:${now.getTime()}` });
                retries++;
            }
            catch (err) {
                // Redis may fail after the DB claim. Put the target back into the retry
                // lane so a later scheduler tick can recover it instead of stranding it.
                await db.update(schema_js_1.postTargets)
                    .set({ state: 'RETRYING', nextRetryAt: new Date(Date.now() + 60_000) })
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, target.id), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'PENDING')));
                log.warn({ err, targetId: target.id }, 'retry_enqueue_failed_requeued');
            }
        }
    }
    return { scheduledPosts, retries, pendingRecoveries };
}
async function runSchedulerTick() {
    const db = (0, client_js_1.getDb)();
    const now = new Date();
    const deliveryRecovery = await runDeliveryRecoveryTick(now);
    const scheduledPosts = deliveryRecovery.scheduledPosts;
    const retries = deliveryRecovery.retries;
    let goldRuns = 0;
    let expiryChecks = 0;
    let campaignRuns = 0;
    // 2) Stale PROCESSING recovery: a worker crash after the atomic claim can
    // otherwise leave a target forever unqueueable. We do NOT auto-requeue it,
    // because the external provider may already have accepted the message.
    // Marking it FAILED makes the condition visible and requires an explicit,
    // human-approved retry that can be reconciled for duplicates.
    const processingCutoff = new Date(now.getTime() - 10 * 60_000);
    const staleProcessing = await db
        .select({ id: schema_js_1.postTargets.id, postId: schema_js_1.postTargets.postId, attempts: schema_js_1.postTargets.attempts, postState: schema_js_1.posts.state })
        .from(schema_js_1.postTargets)
        .innerJoin(schema_js_1.posts, (0, drizzle_orm_1.eq)(schema_js_1.posts.id, schema_js_1.postTargets.postId))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'PROCESSING'), (0, drizzle_orm_1.lte)(schema_js_1.postTargets.updatedAt, processingCutoff)))
        .limit(SECTION_LIMIT);
    for (const target of staleProcessing) {
        const cancelledParent = target.postState === 'CANCELLED' || target.postState === 'DRAFT';
        const repaired = await db
            .update(schema_js_1.postTargets)
            .set(cancelledParent
            ? { state: 'CANCELLED', nextRetryAt: null }
            : {
                state: 'FAILED',
                attempts: target.attempts + 1,
                nextRetryAt: null,
                errorCode: 'WORKER_STALE',
                errorMessage: 'پردازش ارسال بیش از حد طولانی در وضعیت نامشخص مانده است؛ برای جلوگیری از ارسال تکراری، توقف داده شد. قبل از تلاش مجدد مقصد را بررسی کنید.',
            })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, target.id), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'PROCESSING'), (0, drizzle_orm_1.lte)(schema_js_1.postTargets.updatedAt, processingCutoff)));
        if (affectedRowsOf(repaired) > 0 && !cancelledParent) {
            await (0, post_aggregate_js_1.refreshPostAggregate)(target.postId);
        }
    }
    // 4) Maintenance: enqueue at most one bounded retention/reaper sweep per UTC day.
    // A durable BullMQ job keeps cleanup alive without spawning a process from the scheduler.
    const maintenanceDay = now.toISOString().slice(0, 10);
    try {
        await (0, queues_js_1.enqueue)('maintenance', 'sweep', {}, { jobId: `maintenance-${maintenanceDay}` });
    }
    catch (err) {
        log.warn({ err }, 'maintenance_enqueue_failed');
    }
    // 5) Gold ticker: enabled configs past their frequency window.
    const goldRows = await db.select().from(schema_js_1.goldConfigs).where((0, drizzle_orm_1.eq)(schema_js_1.goldConfigs.isEnabled, 1)).limit(SECTION_LIMIT);
    for (const config of goldRows) {
        const due = !config.lastRunAt || now.getTime() - config.lastRunAt.getTime() >= config.frequencyMinutes * 60_000;
        if (!due)
            continue;
        try {
            const result = await (0, gold_service_js_1.runGoldCheck)(config.id);
            if (result.ok)
                goldRuns++;
        }
        catch (err) {
            // Per-config isolation: one broken source must not starve other sections.
            log.warn({ err, configId: config.id }, 'gold_tick_failed');
        }
    }
    // 6) WordPress/WooCommerce campaigns: each campaign is internally isolated.
    // A failure in one campaign never aborts the scheduler lanes below.
    try {
        campaignRuns = await (0, campaign_service_js_1.runDueCampaigns)();
    }
    catch (err) {
        log.warn({ err }, 'wordpress_campaign_tick_failed');
    }
    // 6a) Expiring subscriptions: T-7d warning, exactly-once via unique key.
    const warningHorizon = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const expiring = await db
        .select({ id: schema_js_1.subscriptions.id, tenantId: schema_js_1.subscriptions.tenantId, expiresAt: schema_js_1.subscriptions.expiresAt })
        .from(schema_js_1.subscriptions)
        .innerJoin(schema_js_1.plans, (0, drizzle_orm_1.eq)(schema_js_1.plans.id, schema_js_1.subscriptions.planId))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.state, 'ACTIVE'), 
    // Free-plan subscribers must never receive paid-expiry renewal warnings.
    // The scheduler warning is only meaningful for a paid plan.
    // `plans.code` is the canonical stable discriminator.
    (0, drizzle_orm_1.ne)(schema_js_1.plans.code, 'free'), (0, drizzle_orm_1.lte)(schema_js_1.subscriptions.expiresAt, warningHorizon), (0, drizzle_orm_1.gt)(schema_js_1.subscriptions.expiresAt, now), (0, drizzle_orm_1.sql) `NOT EXISTS (
          SELECT 1
          FROM subscriptions newer
          WHERE newer.tenant_id = ${schema_js_1.subscriptions.tenantId}
            AND newer.state = 'ACTIVE'
            AND newer.expires_at > ${now}
            AND newer.created_at > ${schema_js_1.subscriptions.createdAt}
        )`))
        .limit(SECTION_LIMIT);
    for (const subscription of expiring) {
        await (0, delivery_js_1.createExpiryWarning)({ id: subscription.id, tenantId: subscription.tenantId, expiresAt: subscription.expiresAt }).catch(() => undefined);
        expiryChecks++;
    }
    // 5b) Lapsed subscriptions → EXPIRED + event.
    const lapsed = await db
        .select({ id: schema_js_1.subscriptions.id, tenantId: schema_js_1.subscriptions.tenantId })
        .from(schema_js_1.subscriptions)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.state, 'ACTIVE'), (0, drizzle_orm_1.lt)(schema_js_1.subscriptions.expiresAt, now)))
        .limit(SECTION_LIMIT);
    for (const subscription of lapsed) {
        const expired = await db
            .update(schema_js_1.subscriptions)
            .set({ state: 'EXPIRED' })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.id, subscription.id), (0, drizzle_orm_1.eq)(schema_js_1.subscriptions.state, 'ACTIVE')));
        if (affectedRowsOf(expired) > 0) {
            await (0, events_js_1.emitEvent)({
                name: 'subscription.expired',
                tenantId: subscription.tenantId,
                subjectType: 'subscription',
                subjectId: subscription.id,
            });
            expiryChecks++;
        }
    }
    // 7) Periodic database housekeeping: purge expired session tokens (§40)
    try {
        await (0, sessions_js_1.sweepExpiredSessions)();
    }
    catch (err) {
        log.warn({ err }, 'sweep_expired_sessions_failed');
    }
    return { scheduledPosts, retries, goldRuns, expiryChecks, campaignRuns };
}
