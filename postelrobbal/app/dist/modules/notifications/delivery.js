"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PASSWORD_RESET_DELIVERY_TTL_SECONDS = exports.PASSWORD_RESET_DELIVERY_KEY_PREFIX = void 0;
exports.notifyTenant = notifyTenant;
exports.deletePasswordResetDeliveryToken = deletePasswordResetDeliveryToken;
exports.enqueuePasswordResetDelivery = enqueuePasswordResetDelivery;
exports.createExpiryWarning = createExpiryWarning;
exports.deliverChannelNotification = deliverChannelNotification;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const queues_js_1 = require("../../queue/queues.js");
const connection_js_1 = require("../../queue/connection.js");
const index_js_1 = require("../../providers/index.js");
const encryption_js_1 = require("../../security/encryption.js");
const events_js_1 = require("../../core/events.js");
/**
 * Notification orchestration (§27) — separate from provider adapters.
 * In-app rows are created synchronously (cheap); channel/email/SMS sends are
 * enqueued. The in-app 7-day expiry warning is protected by a DB unique key
 * on (tenant_id, kind, subject_id); channel delivery has its own outbound/job
 * idempotency keys — exactly-once per subscription (§26).
 */
async function notifyTenant(input) {
    const db = (0, client_js_1.getDb)();
    try {
        await db.insert(schema_js_1.notifications).values({
            id: (0, ids_js_1.newId)(),
            tenantId: input.tenantId,
            kind: input.kind,
            subjectId: input.subjectId ?? null,
            titleFa: input.titleFa,
            bodyFa: input.bodyFa,
        });
        return true;
    }
    catch (err) {
        const e = err;
        if (e.code === 'ER_DUP_ENTRY' || e.errno === 1062 || /Duplicate entry/i.test(String(e.message ?? '')))
            return false;
        throw err;
    }
}
exports.PASSWORD_RESET_DELIVERY_KEY_PREFIX = 'postyar:password-reset-delivery:';
exports.PASSWORD_RESET_DELIVERY_TTL_SECONDS = 30 * 60;
async function deletePasswordResetDeliveryToken(resetTokenId) {
    await (0, connection_js_1.getRedis)().del(`${exports.PASSWORD_RESET_DELIVERY_KEY_PREFIX}${resetTokenId}`);
}
async function enqueuePasswordResetDelivery(userId, resetTokenId, token) {
    const db = (0, client_js_1.getDb)();
    const [user] = await db.select({ email: schema_js_1.users.email, mobile: schema_js_1.users.mobile }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId)).limit(1);
    if (!user)
        return;
    const redis = (0, connection_js_1.getRedis)();
    const key = `${exports.PASSWORD_RESET_DELIVERY_KEY_PREFIX}${resetTokenId}`;
    const stored = await redis.set(key, token, 'EX', exports.PASSWORD_RESET_DELIVERY_TTL_SECONDS);
    if (stored !== 'OK')
        throw new Error('PASSWORD_RESET_DELIVERY_TOKEN_STORE_FAILED');
    try {
        // The queue payload contains only an opaque database row ID. Completed and
        // failed BullMQ job retention therefore cannot retain the reset secret.
        await (0, queues_js_1.enqueue)('notifications', 'password-reset', {
            kind: 'PASSWORD_RESET',
            tenantId: userId,
            email: user.email,
            mobile: user.mobile,
            passwordResetTokenId: resetTokenId,
        });
    }
    catch (err) {
        await redis.del(key).catch(() => undefined);
        throw err;
    }
}
/**
 * Seven-day subscription expiry warning (§26): durable, idempotent.
 * Creates an idempotent in-app row and durable outbound records; the unique
 * keys guarantee the same logical warning is not duplicated for one subscription.
 */
async function createExpiryWarning(subscription) {
    const db = (0, client_js_1.getDb)();
    const title = 'اشتراک شما به‌زودی منقضی می‌شود';
    const body = `اشتراک شما در پُست‌یار تا تاریخ انقضا به پایان می‌رسد. برای جلوگیری از وقفه در سرویس، اشتراک خود را تمدید کنید.`;
    // In-app delivery is idempotent by (tenant_id, kind, subject_id);
    // channel delivery has independent outbound/job idempotency keys.
    await notifyTenant({
        tenantId: subscription.tenantId,
        kind: 'SUBSCRIPTION_EXPIRY_7D',
        subjectId: subscription.id,
        titleFa: title,
        bodyFa: body,
    });
    // Message destinations: publish through the tenant's active channels once each
    const tenantChannels = await db
        .select({ id: schema_js_1.channels.id, platform: schema_js_1.channels.platform, channelRef: schema_js_1.channels.channelRef, status: schema_js_1.channels.status })
        .from(schema_js_1.channels)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, subscription.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE')));
    for (const ch of tenantChannels) {
        const destination = ch.platform.toUpperCase();
        await db
            .insert(schema_js_1.notificationOutbound)
            .values({
            id: (0, ids_js_1.newId)(),
            kind: 'SUBSCRIPTION_EXPIRY_7D',
            subjectId: subscription.id,
            tenantId: subscription.tenantId,
            channelId: ch.id,
            destination,
            state: 'PENDING',
        })
            .onDuplicateKeyUpdate({ set: { subjectId: subscription.id } });
        await (0, queues_js_1.enqueue)('notifications', 'expiry-warning', {
            outboundKind: 'SUBSCRIPTION_EXPIRY_7D',
            subjectId: subscription.id,
            destination,
            platform: ch.platform,
            channelId: ch.id,
            channelRef: ch.channelRef,
            tenantId: subscription.tenantId,
            title,
            body,
        }, { jobId: `expw:${subscription.id}:${ch.id}` });
    }
    await (0, events_js_1.emitEvent)({ name: 'subscription.expiring', tenantId: subscription.tenantId, subjectType: 'subscription', subjectId: subscription.id });
}
/** Used by the notifications worker to actually deliver channel messages. */
async function deliverChannelNotification(job) {
    const db = (0, client_js_1.getDb)();
    const provider = (0, index_js_1.getProvider)(job.platform);
    const { bots } = await import('../../db/schema.js');
    const [channel] = await db
        .select({ id: schema_js_1.channels.id, channelRef: schema_js_1.channels.channelRef, botId: schema_js_1.channels.botId, platform: schema_js_1.channels.platform })
        .from(schema_js_1.channels)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.id, job.channelId), (0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, job.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.platform, job.platform), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE')))
        .limit(1);
    if (!channel)
        return;
    const [bot] = await db
        .select()
        .from(bots)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(bots.id, channel.botId ?? ''), (0, drizzle_orm_1.eq)(bots.tenantId, job.tenantId), (0, drizzle_orm_1.eq)(bots.platform, job.platform), (0, drizzle_orm_1.eq)(bots.status, 'ACTIVE')))
        .limit(1);
    const row = await db
        .select()
        .from(schema_js_1.notificationOutbound)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.kind, job.outboundKind), (0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.subjectId, job.subjectId), (0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.channelId, channel.id), (0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.destination, job.destination)))
        .limit(1);
    const outboundRow = row[0];
    if (!outboundRow)
        return;
    // Claim atomically before any provider side effect. Without a durable claim,
    // duplicate BullMQ jobs can deliver the same notification more than once.
    const claimed = await db
        .update(schema_js_1.notificationOutbound)
        .set({ state: 'PROCESSING', attempts: (0, drizzle_orm_1.sql) `${schema_js_1.notificationOutbound.attempts} + 1` })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.id, outboundRow.id), (0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.state, 'PENDING')));
    const claimedRows = Array.isArray(claimed)
        ? Number(claimed[0]?.affectedRows ?? 0)
        : Number(claimed?.affectedRows ?? 0);
    if (claimedRows === 0)
        return;
    const markFailed = async (err) => {
        await db
            .update(schema_js_1.notificationOutbound)
            .set({ state: 'FAILED', lastError: err.slice(0, 250) })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.id, outboundRow.id), (0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.state, 'PROCESSING')));
    };
    const markSent = async () => {
        await db
            .update(schema_js_1.notificationOutbound)
            .set({ state: 'SENT', sentAt: new Date() })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.id, outboundRow.id), (0, drizzle_orm_1.eq)(schema_js_1.notificationOutbound.state, 'PROCESSING')));
    };
    if (!bot) {
        await markFailed('ربات فعال برای این پلتفرم یافت نشد.');
        return;
    }
    try {
        const token = (0, encryption_js_1.decryptSecret)(bot.tokenEncrypted);
        await provider.sendText(token, { chatRef: channel.channelRef, text: `${job.title}\n\n${job.body}` });
        await markSent();
    }
    catch (err) {
        await markFailed(err.message);
    }
}
