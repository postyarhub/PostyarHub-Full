"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPost = createPost;
exports.publishNow = publishNow;
exports.schedulePost = schedulePost;
exports.updateScheduledPost = updateScheduledPost;
exports.listPosts = listPosts;
exports.getPost = getPost;
exports.cancelPost = cancelPost;
exports.retryTarget = retryTarget;
exports.deletePost = deletePost;
exports.deletePostsBulk = deletePostsBulk;
exports.affectedRowsOf = affectedRowsOf;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const errors_js_1 = require("../../core/errors.js");
const outbox_js_1 = require("../../core/outbox.js");
const events_js_1 = require("../../core/events.js");
const audit_js_1 = require("../../core/audit.js");
const queues_js_1 = require("../../queue/queues.js");
const plan_service_js_1 = require("../subscriptions/plan.service.js");
const post_aggregate_js_1 = require("../../core/post-aggregate.js");
const logger_js_1 = require("../../core/logger.js");
/**
 * Publishing domain (§22, §25): DRAFT → (SCHEDULED →) QUEUED → PUBLISHING →
 * PUBLISHED/PARTIAL/FAILED, CANCELLED from SCHEDULED/QUEUED. Per-target state
 * machine lives in core/delivery-state. The outbox row is written in the SAME
 * transaction as the state flip (§125) — the dispatcher fans out targets.
 */
const log = (0, logger_js_1.createLogger)('post-service');
const MAX_POST_BODY_LENGTH = 4000;
const MAX_CHANNEL_FOOTER_LENGTH = 500;
function assertFooterLengths(body, buttons) {
    const base = body.trim();
    for (const raw of Object.values(buttons?.footerByChannel ?? {})) {
        const footer = typeof raw === 'string' ? raw.trim() : '';
        if (!footer)
            continue;
        if (footer.length > MAX_CHANNEL_FOOTER_LENGTH)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('متن انتهایی هر کانال حداکثر ۵۰۰ نویسه است.'));
        const total = base.length + (base ? 2 : 0) + footer.length;
        if (total > MAX_POST_BODY_LENGTH)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مجموع متن پست و متن انتهایی هر کانال نباید از ۴۰۰۰ نویسه بیشتر شود.'));
    }
}
function cleanSearch(term) {
    return term.replace(/[%_]/g, ' ').trim();
}
async function requireOwnedPost(tenantId, postId) {
    const db = (0, client_js_1.getDb)();
    const [post] = await db
        .select()
        .from(schema_js_1.posts)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, postId), (0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId)))
        .limit(1);
    if (!post)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پست'));
    return post;
}
async function resolveActiveChannels(tenantId, channelIds) {
    const unique = [...new Set(channelIds)];
    if (unique.length === 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('حداقل یک کانال انتخاب کنید.'));
    }
    const db = (0, client_js_1.getDb)();
    const rows = await db
        .select({ id: schema_js_1.channels.id, platform: schema_js_1.channels.platform, botId: schema_js_1.channels.botId })
        .from(schema_js_1.channels)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE'), (0, drizzle_orm_1.inArray)(schema_js_1.channels.id, unique)));
    if (rows.length !== unique.length) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('یکی از کانال‌های انتخاب‌شده معتبر یا فعال نیست.'));
    }
    for (const row of rows) {
        if (row.botId) {
            const [activeBot] = await db
                .select({ id: schema_js_1.bots.id })
                .from(schema_js_1.bots)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, row.botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, row.platform), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE')))
                .limit(1);
            if (!activeBot)
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('یکی از کانال‌ها به ربات فعال معتبر متصل نیست.'));
            continue;
        }
        const activeBots = await db
            .select({ id: schema_js_1.bots.id })
            .from(schema_js_1.bots)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, row.platform), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE')))
            .limit(2);
        if (activeBots.length !== 1 || !activeBots[0]) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(activeBots.length > 1
                ? 'یکی از کانال‌ها بیش از یک ربات فعال دارد؛ ربات مقصد را مشخص کنید.'
                : 'یکی از کانال‌ها ربات فعال ندارد. ابتدا ربات همان پلتفرم را متصل و فعال کنید.'));
        }
        await db.update(schema_js_1.channels).set({ botId: activeBots[0].id, updatedAt: new Date() }).where((0, drizzle_orm_1.eq)(schema_js_1.channels.id, row.id));
    }
    return unique;
}
async function resolvePostMediaIds(tenantId, requestedMediaIds, legacyMediaId) {
    const requested = requestedMediaIds !== undefined
        ? requestedMediaIds
        : legacyMediaId ? [legacyMediaId] : [];
    const mediaIds = [...new Set(requested)];
    if (mediaIds.length > 10) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای هر پست حداکثر ۱۰ تصویر قابل انتخاب است.'));
    }
    if (mediaIds.length === 0)
        return { mediaIds: [], mediaId: null };
    const rows = await (0, client_js_1.getDb)()
        .select({ id: schema_js_1.media.id, mime: schema_js_1.media.mime, sizeBytes: schema_js_1.media.sizeBytes })
        .from(schema_js_1.media)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.media.tenantId, tenantId), (0, drizzle_orm_1.inArray)(schema_js_1.media.id, mediaIds)));
    if (rows.length !== mediaIds.length) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('یکی از رسانه‌های انتخاب‌شده معتبر نیست یا به حساب شما تعلق ندارد.'));
    }
    const totalStoredBytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
    if (totalStoredBytes > 20 * 1024 * 1024) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('حجم مجموع تصاویر یک پست نباید بیشتر از ۲۰ مگابایت باشد.'));
    }
    const videos = rows.filter((row) => row.mime === 'video/mp4');
    if (rows.some((row) => !(row.mime.startsWith('image/') || row.mime === 'video/mp4'))) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای انتشار فقط تصویر یا ویدئوی MP4 قابل استفاده است.'));
    }
    if (videos.length > 0 && (videos.length !== 1 || mediaIds.length !== 1)) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ویدئو را باید به‌تنهایی ارسال کنید؛ در یک پست نمی‌توان ویدئو را با تصاویر ترکیب کرد.'));
    }
    return { mediaIds, mediaId: mediaIds[0] ?? null };
}
function ensurePublishableState(state) {
    if (state === 'QUEUED' || state === 'PUBLISHING') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('این پست در حال انتشار است و امکان تغییر آن نیست.'));
    }
}
async function createPost(tenantId, input, meta = {}) {
    const db = (0, client_js_1.getDb)();
    const body = (input.body ?? '').trim();
    if (body.length > MAX_POST_BODY_LENGTH) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('متن پست پس از آماده‌سازی نباید از ۴۰۰۰ نویسه بیشتر باشد.'));
    }
    assertFooterLengths(body, input.buttons);
    const resolvedMedia = await resolvePostMediaIds(tenantId, input.mediaIds, input.mediaId);
    const mediaIds = resolvedMedia.mediaIds;
    const mediaId = resolvedMedia.mediaId;
    if (!body && mediaIds.length === 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('پست باید حداقل متن یا رسانه داشته باشد.'));
    }
    const destinationSettingChannelIds = [...new Set([
            ...Object.keys(input.buttons?.byChannel ?? {}),
            ...Object.keys(input.buttons?.footerByChannel ?? {}),
        ])];
    if (destinationSettingChannelIds.length) {
        const ownedSettingChannels = await db
            .select({ id: schema_js_1.channels.id })
            .from(schema_js_1.channels)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.inArray)(schema_js_1.channels.id, destinationSettingChannelIds)));
        if (ownedSettingChannels.length !== destinationSettingChannelIds.length) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('تنظیمات اختصاصی دکمه یا متن انتهایی به یکی از کانال‌های معتبر حساب شما تعلق ندارد.'));
        }
    }
    const id = (0, ids_js_1.newId)();
    await db.insert(schema_js_1.posts).values({
        id,
        tenantId,
        title: input.title?.trim() || null,
        body,
        parseMode: input.parseMode ?? 'NONE',
        mediaId,
        mediaIds: mediaIds.length ? mediaIds : null,
        buttonsJson: input.buttons ?? null,
        source: input.source ?? 'MANUAL',
        state: 'DRAFT',
    });
    const post = await requireOwnedPost(tenantId, id);
    await (0, events_js_1.emitEvent)({ name: 'post.created', tenantId, subjectType: 'post', subjectId: id, props: { hasMedia: mediaIds.length > 0, mediaCount: mediaIds.length } });
    await (0, audit_js_1.audit)({
        action: 'post.create',
        actorId: meta.actorId ?? null,
        actorRole: meta.actorRole ?? null,
        subjectType: 'post',
        subjectId: id,
        ip: meta.ip ?? undefined,
    });
    return post;
}
async function publishNow(tenantId, postId, channelIds, meta = {}) {
    const post = await requireOwnedPost(tenantId, postId);
    ensurePublishableState(post.state);
    const uniqueChannels = await resolveActiveChannels(tenantId, channelIds);
    const db = (0, client_js_1.getDb)();
    let publishOutboxId = null;
    await db.transaction(async (tx) => {
        // Serialize quota-sensitive post mutations per tenant. The quota count is
        // evaluated while the tenant row is locked, preventing concurrent requests
        // from both consuming the last available post slot.
        await tx.select({ id: schema_js_1.users.id }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, tenantId)).limit(1).for('update');
        await (0, plan_service_js_1.assertWithinLimit)(tenantId, 'posts');
        const flipped = await tx
            .update(schema_js_1.posts)
            .set({ state: 'QUEUED', scheduledAt: null })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, postId), (0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.posts.state, post.state)));
        if (affectedRowsOf(flipped) === 0) {
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('وضعیت پست همزمان تغییر کرده است. صفحه را تازه کنید و دوباره تلاش کنید.'));
        }
        for (const channelId of uniqueChannels) {
            await tx
                .insert(schema_js_1.postTargets)
                .values({ id: (0, ids_js_1.newId)(), postId, tenantId, channelId, state: 'PENDING' })
                .onDuplicateKeyUpdate({
                // Never resurrect already-delivered targets on re-publish (§23):
                // SENT stays SENT; only non-terminal states return to PENDING.
                set: {
                    state: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', 'SENT', 'PENDING')`,
                    attempts: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', ${schema_js_1.postTargets.attempts}, 0)`,
                    errorCode: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', ${schema_js_1.postTargets.errorCode}, NULL)`,
                    errorMessage: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', ${schema_js_1.postTargets.errorMessage}, NULL)`,
                    nextRetryAt: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', ${schema_js_1.postTargets.nextRetryAt}, NULL)`,
                    sentAt: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', ${schema_js_1.postTargets.sentAt}, NULL)`,
                    providerMessageId: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', ${schema_js_1.postTargets.providerMessageId}, NULL)`,
                },
            });
        }
        const outbox = (0, outbox_js_1.outboxRow)({ aggregateType: 'post', aggregateId: postId, eventType: 'post.publish', payload: {} });
        publishOutboxId = outbox.id;
        await tx.insert(schema_js_1.outboxEvents).values(outbox);
    });
    // Fast path: enqueue pending targets immediately after commit. The durable
    // outbox remains the recovery path when Redis is temporarily unavailable.
    const pendingTargets = await db
        .select({ id: schema_js_1.postTargets.id })
        .from(schema_js_1.postTargets)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.postId, postId), (0, drizzle_orm_1.inArray)(schema_js_1.postTargets.state, ['PENDING', 'RETRYING'])));
    if (!publishOutboxId)
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    for (let i = 0; i < pendingTargets.length; i++) {
        const target = pendingTargets[i];
        try {
            // The outbox id represents the publish generation. Re-publishing the same
            // post/channel must not collide with a completed BullMQ job retained in Redis.
            // Stagger enqueued delivery jobs slightly (350ms apart) so multiple destinations
            // do not simultaneously flood external provider APIs and cause socket drops.
            await (0, queues_js_1.enqueue)('delivery', 'deliver', { targetId: target.id }, { jobId: `deliver:${target.id}:${publishOutboxId}`, delayMs: i * 350 });
        }
        catch (err) {
            log.warn({ postId, targetId: target.id, errorName: err instanceof Error ? err.name : 'UnknownError', errorMessage: String(err instanceof Error ? err.message : err ?? '').slice(0, 180) }, 'publish_fast_path_enqueue_failed');
            // The post/outbox transaction is already durable; the relay will recover
            // this target when Redis becomes available again.
        }
    }
    // A publish request against destinations that are already SENT creates no
    // pending job. Restore the aggregate instead of leaving the post QUEUED forever.
    if (pendingTargets.length === 0)
        await (0, post_aggregate_js_1.refreshPostAggregate)(postId);
    await (0, audit_js_1.audit)({
        action: 'post.publish',
        actorId: meta.actorId ?? null,
        actorRole: meta.actorRole ?? null,
        subjectType: 'post',
        subjectId: postId,
        ip: meta.ip ?? undefined,
        meta: { channels: uniqueChannels.length },
    });
    return requireOwnedPost(tenantId, postId);
}
async function schedulePost(tenantId, postId, channelIds, scheduledAt, meta = {}) {
    const post = await requireOwnedPost(tenantId, postId);
    ensurePublishableState(post.state);
    if (!(scheduledAt.getTime() > Date.now())) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('زمان انتشار باید در آینده باشد.'));
    }
    const uniqueChannels = await resolveActiveChannels(tenantId, channelIds);
    const db = (0, client_js_1.getDb)();
    await db.transaction(async (tx) => {
        await tx.select({ id: schema_js_1.users.id }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, tenantId)).limit(1).for('update');
        await (0, plan_service_js_1.assertWithinLimit)(tenantId, 'schedules');
        const flipped = await tx
            .update(schema_js_1.posts)
            .set({ state: 'SCHEDULED', scheduledAt })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, postId), (0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.posts.state, post.state)));
        if (affectedRowsOf(flipped) === 0) {
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('وضعیت پست همزمان تغییر کرده است. صفحه را تازه کنید و دوباره تلاش کنید.'));
        }
        for (const channelId of uniqueChannels) {
            await tx
                .insert(schema_js_1.postTargets)
                .values({ id: (0, ids_js_1.newId)(), postId, tenantId, channelId, state: 'PENDING' })
                .onDuplicateKeyUpdate({
                // Never resurrect already-delivered targets on re-publish (§23):
                // SENT stays SENT; only non-terminal states return to PENDING.
                set: {
                    state: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', 'SENT', 'PENDING')`,
                    attempts: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', ${schema_js_1.postTargets.attempts}, 0)`,
                    errorCode: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', ${schema_js_1.postTargets.errorCode}, NULL)`,
                    errorMessage: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', ${schema_js_1.postTargets.errorMessage}, NULL)`,
                    nextRetryAt: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', ${schema_js_1.postTargets.nextRetryAt}, NULL)`,
                    sentAt: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', ${schema_js_1.postTargets.sentAt}, NULL)`,
                    providerMessageId: (0, drizzle_orm_1.sql) `IF(${schema_js_1.postTargets.state} = 'SENT', ${schema_js_1.postTargets.providerMessageId}, NULL)`,
                },
            });
        }
    });
    // Scheduling a destination already marked SENT has no future work. Do not leave
    // a no-op scheduled post in SCHEDULED/QUEUED state with nothing to deliver.
    const pendingScheduledTargets = await db
        .select({ id: schema_js_1.postTargets.id })
        .from(schema_js_1.postTargets)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.postId, postId), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'PENDING')))
        .limit(500);
    if (!pendingScheduledTargets.length)
        await (0, post_aggregate_js_1.refreshPostAggregate)(postId);
    // DB is the canonical schedule clock. Do not create a delayed BullMQ job here:
    // the durable SCHEDULED row is the persisted contract, and the worker (30s) +
    // scheduler (1m) recovery lanes promote due rows into the transactional outbox.
    // This removes Redis delayed-job state from the correctness path while keeping
    // legacy `publish-scheduled` jobs idempotently supported by the delivery worker.
    await (0, events_js_1.emitEvent)({ name: 'post.scheduled', tenantId, subjectType: 'post', subjectId: postId });
    await (0, audit_js_1.audit)({
        action: 'post.schedule',
        actorId: meta.actorId ?? null,
        actorRole: meta.actorRole ?? null,
        subjectType: 'post',
        subjectId: postId,
        ip: meta.ip ?? undefined,
        meta: { channels: uniqueChannels.length, scheduledAt: scheduledAt.toISOString() },
    });
    return requireOwnedPost(tenantId, postId);
}
/**
 * Update an upcoming scheduled post atomically. Editing is permitted only while
 * the parent is still SCHEDULED, its time is still in the future, and every
 * existing destination remains PENDING. Parent and target rows are locked so
 * the scheduler/worker cannot claim a destination halfway through the edit.
 */
async function updateScheduledPost(tenantId, postId, input, meta = {}) {
    const db = (0, client_js_1.getDb)();
    const now = new Date();
    const body = (input.body ?? '').trim();
    const requestedTime = input.scheduledAt;
    if (body.length > MAX_POST_BODY_LENGTH) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('متن پست پس از آماده‌سازی نباید از ۴۰۰۰ نویسه بیشتر باشد.'));
    }
    if (!requestedTime || Number.isNaN(requestedTime.getTime()) || requestedTime.getTime() <= now.getTime()) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('زمان انتشار باید در آینده باشد.'));
    }
    const resolvedMedia = await resolvePostMediaIds(tenantId, input.mediaIds, input.mediaId);
    const mediaIds = resolvedMedia.mediaIds;
    const mediaId = resolvedMedia.mediaId;
    if (!body && mediaIds.length === 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('پست باید حداقل متن یا رسانه داشته باشد.'));
    }
    assertFooterLengths(body, input.buttons);
    const uniqueChannels = await resolveActiveChannels(tenantId, input.channelIds);
    const selectedChannelSet = new Set(uniqueChannels);
    const destinationSettingChannelIds = [...new Set([
            ...Object.keys(input.buttons?.byChannel ?? {}),
            ...Object.keys(input.buttons?.footerByChannel ?? {}),
        ])];
    if (destinationSettingChannelIds.some((id) => !selectedChannelSet.has(id))) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('دکمه‌ها و متن انتهایی فقط باید به کانال‌های انتخاب‌شده تعلق داشته باشند.'));
    }
    if (destinationSettingChannelIds.length) {
        const ownedSettingChannels = await db
            .select({ id: schema_js_1.channels.id })
            .from(schema_js_1.channels)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.inArray)(schema_js_1.channels.id, destinationSettingChannelIds)));
        if (ownedSettingChannels.length !== destinationSettingChannelIds.length) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('تنظیمات اختصاصی دکمه یا متن انتهایی به یکی از کانال‌های معتبر حساب شما تعلق ندارد.'));
        }
    }
    await db.transaction(async (tx) => {
        // Lock the owned post first. This serializes edits with schedule/publish/cancel.
        const [post] = await tx
            .select({ id: schema_js_1.posts.id, state: schema_js_1.posts.state, scheduledAt: schema_js_1.posts.scheduledAt })
            .from(schema_js_1.posts)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, postId), (0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId)))
            .limit(1)
            .for('update');
        if (!post)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پست'));
        if (post.state !== 'SCHEDULED' || !post.scheduledAt || post.scheduledAt.getTime() <= Date.now()) {
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('فقط پست زمان‌بندی‌شده‌ای که هنوز موعد انتشارش نرسیده قابل ویرایش است.'));
        }
        // Lock all current destinations and reject any in-flight/terminal state.
        const existingTargets = await tx
            .select({ id: schema_js_1.postTargets.id, channelId: schema_js_1.postTargets.channelId, state: schema_js_1.postTargets.state })
            .from(schema_js_1.postTargets)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.postId, postId), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.tenantId, tenantId)))
            .for('update');
        // CANCELLED rows are retained as delivery history when a destination is
        // removed from an earlier edit. They are not current destinations and must
        // not permanently make the otherwise-upcoming post uneditable.
        const activeTargets = existingTargets.filter((target) => target.state !== 'CANCELLED');
        if (activeTargets.length === 0 || activeTargets.some((target) => target.state !== 'PENDING')) {
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('این پست فقط وقتی قابل ویرایش است که همهٔ مقصدهای فعال آن هنوز در انتظار ارسال باشند.'));
        }
        const updateNow = new Date();
        if (requestedTime.getTime() <= updateNow.getTime()) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('زمان انتشار باید در آینده باشد.'));
        }
        const changed = await tx
            .update(schema_js_1.posts)
            .set({
            title: input.title?.trim() || null,
            body,
            parseMode: input.parseMode ?? 'NONE',
            mediaId,
            mediaIds: mediaIds.length ? mediaIds : null,
            buttonsJson: input.buttons ?? null,
            scheduledAt: requestedTime,
        })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, postId), (0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.posts.state, 'SCHEDULED'), (0, drizzle_orm_1.gt)(schema_js_1.posts.scheduledAt, updateNow)));
        if (affectedRowsOf(changed) === 0) {
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('وضعیت پست همزمان تغییر کرده است؛ صفحه را تازه کنید.'));
        }
        const existingChannelSet = new Set(activeTargets.map((target) => target.channelId));
        const targetByChannel = new Map(existingTargets.map((target) => [target.channelId, target]));
        const removedTargetIds = activeTargets
            .filter((target) => !selectedChannelSet.has(target.channelId))
            .map((target) => target.id);
        if (removedTargetIds.length) {
            await tx
                .update(schema_js_1.postTargets)
                .set({ state: 'CANCELLED', nextRetryAt: null })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.inArray)(schema_js_1.postTargets.id, removedTargetIds), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'PENDING')));
        }
        for (const channelId of uniqueChannels) {
            if (existingChannelSet.has(channelId))
                continue;
            const previousTarget = targetByChannel.get(channelId);
            if (previousTarget?.state === 'CANCELLED') {
                // A removed target may be selected again while this post is still
                // scheduled. Reactivate its existing unique row instead of colliding
                // with the (postId, channelId) unique key.
                await tx
                    .update(schema_js_1.postTargets)
                    .set({
                    state: 'PENDING',
                    attempts: 0,
                    errorCode: null,
                    errorMessage: null,
                    nextRetryAt: null,
                    sentAt: null,
                    providerMessageId: null,
                })
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, previousTarget.id), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'CANCELLED')));
                continue;
            }
            if (previousTarget) {
                throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('وضعیت یکی از مقصدها همزمان تغییر کرده است؛ صفحه را تازه کنید.'));
            }
            await tx.insert(schema_js_1.postTargets).values({
                id: (0, ids_js_1.newId)(),
                postId,
                tenantId,
                channelId,
                state: 'PENDING',
            });
        }
    });
    await (0, events_js_1.emitEvent)({
        name: 'post.scheduled.updated',
        tenantId,
        subjectType: 'post',
        subjectId: postId,
        props: { channels: uniqueChannels.length, scheduledAt: requestedTime.toISOString() },
    });
    await (0, audit_js_1.audit)({
        action: 'post.schedule.update',
        actorId: meta.actorId ?? null,
        actorRole: meta.actorRole ?? null,
        subjectType: 'post',
        subjectId: postId,
        ip: meta.ip ?? undefined,
        meta: { channels: uniqueChannels.length, scheduledAt: requestedTime.toISOString() },
    });
    return requireOwnedPost(tenantId, postId);
}
async function listPosts(tenantId, query) {
    const db = (0, client_js_1.getDb)();
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const conditions = [(0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId)];
    if (query.state)
        conditions.push((0, drizzle_orm_1.eq)(schema_js_1.posts.state, query.state));
    if (query.channelId) {
        conditions.push((0, drizzle_orm_1.inArray)(schema_js_1.posts.id, db.select({ postId: schema_js_1.postTargets.postId })
            .from(schema_js_1.postTargets)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.channelId, query.channelId)))));
    }
    const search = query.search ? cleanSearch(query.search) : '';
    if (search) {
        const pattern = `%${search}%`;
        const cond = (0, drizzle_orm_1.or)((0, drizzle_orm_1.like)(schema_js_1.posts.title, pattern), (0, drizzle_orm_1.like)(schema_js_1.posts.body, pattern));
        if (cond)
            conditions.push(cond);
    }
    const where = (0, drizzle_orm_1.and)(...conditions);
    const [countRow] = await db.select({ total: (0, drizzle_orm_1.sql) `count(*)` }).from(schema_js_1.posts).where(where);
    const total = Number(countRow?.total ?? 0);
    const rows = await db
        .select()
        .from(schema_js_1.posts)
        .where(where)
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.posts.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
    const ids = rows.map((r) => r.id);
    const summaryRows = ids.length
        ? await db
            .select({ postId: schema_js_1.postTargets.postId, state: schema_js_1.postTargets.state, count: (0, drizzle_orm_1.sql) `count(*)` })
            .from(schema_js_1.postTargets)
            .where((0, drizzle_orm_1.inArray)(schema_js_1.postTargets.postId, ids))
            .groupBy(schema_js_1.postTargets.postId, schema_js_1.postTargets.state)
        : [];
    const channelRows = ids.length
        ? await db.select({ postId: schema_js_1.postTargets.postId, channelId: schema_js_1.postTargets.channelId, channelTitle: schema_js_1.channels.title, state: schema_js_1.postTargets.state, sentAt: schema_js_1.postTargets.sentAt, platform: schema_js_1.channels.platform })
            .from(schema_js_1.postTargets)
            .innerJoin(schema_js_1.channels, (0, drizzle_orm_1.eq)(schema_js_1.channels.id, schema_js_1.postTargets.channelId))
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.inArray)(schema_js_1.postTargets.postId, ids)))
        : [];
    const items = rows.map((row) => {
        const postTargetsForRow = channelRows.filter((target) => target.postId === row.id);
        const platformCounts = new Map();
        let latestSentAt = null;
        for (const target of postTargetsForRow) {
            if (target.state === 'CANCELLED')
                continue;
            const key = String(target.platform ?? '');
            const current = platformCounts.get(key) ?? { platform: key, count: 0, sentCount: 0, failedCount: 0 };
            current.count += 1;
            if (target.state === 'SENT')
                current.sentCount += 1;
            if (target.state === 'FAILED')
                current.failedCount += 1;
            platformCounts.set(key, current);
            if (target.state === 'SENT' && target.sentAt && (!latestSentAt || target.sentAt.getTime() > latestSentAt.getTime()))
                latestSentAt = target.sentAt;
        }
        return {
            ...row,
            targetSummary: summaryRows.filter((s) => s.postId === row.id).map((s) => ({ state: s.state, count: Number(s.count) })),
            channelSummary: [...platformCounts.values()].sort((a, b) => a.platform.localeCompare(b.platform)),
            channelDetails: postTargetsForRow
                .filter((target) => target.state !== 'CANCELLED')
                .map((target) => ({ channelId: target.channelId, title: target.channelTitle, platform: String(target.platform ?? ''), state: target.state }))
                .sort((a, b) => a.title.localeCompare(b.title)),
            latestSentAt,
        };
    });
    return { items, total, page, pageSize };
}
async function getPost(tenantId, postId) {
    const db = (0, client_js_1.getDb)();
    const post = await requireOwnedPost(tenantId, postId);
    const requestedMediaIds = Array.isArray(post.mediaIds) && post.mediaIds.length
        ? post.mediaIds
        : post.mediaId ? [post.mediaId] : [];
    const mediaRows = requestedMediaIds.length
        ? await db
            .select({ id: schema_js_1.media.id, filename: schema_js_1.media.filename, mime: schema_js_1.media.mime, sizeBytes: schema_js_1.media.sizeBytes })
            .from(schema_js_1.media)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.media.tenantId, tenantId), (0, drizzle_orm_1.inArray)(schema_js_1.media.id, requestedMediaIds)))
        : [];
    const mediaById = new Map(mediaRows.map((item) => [item.id, item]));
    const mediaItems = requestedMediaIds.map((id) => mediaById.get(id)).filter((item) => Boolean(item));
    const mediaInfo = mediaItems[0] ?? null;
    const targets = await db
        .select({
        id: schema_js_1.postTargets.id,
        channelId: schema_js_1.postTargets.channelId,
        state: schema_js_1.postTargets.state,
        attempts: schema_js_1.postTargets.attempts,
        providerMessageId: schema_js_1.postTargets.providerMessageId,
        errorCode: schema_js_1.postTargets.errorCode,
        errorMessage: schema_js_1.postTargets.errorMessage,
        sentAt: schema_js_1.postTargets.sentAt,
        nextRetryAt: schema_js_1.postTargets.nextRetryAt,
        platform: schema_js_1.channels.platform,
        channelTitle: schema_js_1.channels.title,
        channelRef: schema_js_1.channels.channelRef,
    })
        .from(schema_js_1.postTargets)
        .innerJoin(schema_js_1.channels, (0, drizzle_orm_1.eq)(schema_js_1.channels.id, schema_js_1.postTargets.channelId))
        .where((0, drizzle_orm_1.eq)(schema_js_1.postTargets.postId, post.id))
        .orderBy(schema_js_1.postTargets.createdAt);
    return { post, targets, media: mediaInfo, mediaItems };
}
async function cancelPost(tenantId, postId, meta = {}) {
    const db = (0, client_js_1.getDb)();
    const post = await requireOwnedPost(tenantId, postId);
    if (post.state !== 'SCHEDULED' && post.state !== 'QUEUED') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('فقط پست‌های زمان‌بندی‌شده یا در صف انتشار قابل لغو هستند.'));
    }
    await db.transaction(async (tx) => {
        const flipped = await tx
            .update(schema_js_1.posts)
            .set({ state: 'CANCELLED' })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, postId), (0, drizzle_orm_1.inArray)(schema_js_1.posts.state, ['SCHEDULED', 'QUEUED'])));
        if (affectedRowsOf(flipped) === 0) {
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('وضعیت پست همزمان تغییر کرده است. صفحه را تازه کنید و دوباره تلاش کنید.'));
        }
        // PENDING/RETRYING targets are cancelled; SENT ones are kept (already delivered).
        await tx
            .update(schema_js_1.postTargets)
            .set({ state: 'CANCELLED', nextRetryAt: null })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.postId, postId), (0, drizzle_orm_1.inArray)(schema_js_1.postTargets.state, ['PENDING', 'RETRYING'])));
    });
    await (0, audit_js_1.audit)({
        action: 'post.cancel',
        actorId: meta.actorId ?? null,
        actorRole: meta.actorRole ?? null,
        subjectType: 'post',
        subjectId: postId,
        ip: meta.ip ?? undefined,
    });
    return requireOwnedPost(tenantId, postId);
}
async function retryTarget(tenantId, targetId, meta = {}) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({ targetId: schema_js_1.postTargets.id, state: schema_js_1.postTargets.state, postId: schema_js_1.postTargets.postId, postState: schema_js_1.posts.state })
        .from(schema_js_1.postTargets)
        .innerJoin(schema_js_1.posts, (0, drizzle_orm_1.eq)(schema_js_1.posts.id, schema_js_1.postTargets.postId))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, targetId), (0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId)))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('مقصدهای ارسال'));
    if (row.state !== 'FAILED' && !(row.state === 'CANCELLED' && row.postState !== 'CANCELLED')) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('فقط ارسال‌های ناموفق قابل تلاش مجدد هستند.'));
    }
    if (row.postState === 'CANCELLED' || row.postState === 'DRAFT') {
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('این پست دیگر قابل تلاش مجدد نیست. ابتدا یک انتشار جدید برای پست ایجاد کنید.'));
    }
    if (row.postState === 'QUEUED' || row.postState === 'SCHEDULED') {
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('این پست هم‌اکنون در چرخهٔ انتشار است.'));
    }
    await db.transaction(async (tx) => {
        // Atomically claim FAILED/CANCELLED → PENDING and make the aggregate recoverable.
        const claimed = await tx
            .update(schema_js_1.postTargets)
            .set({ state: 'PENDING', attempts: 0, nextRetryAt: null, errorCode: null, errorMessage: null })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, targetId), (0, drizzle_orm_1.inArray)(schema_js_1.postTargets.state, ['FAILED', 'CANCELLED'])));
        if (affectedRowsOf(claimed) === 0) {
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('این مقصد هم‌اکنون در حال پردازش است.'));
        }
        const flipped = await tx
            .update(schema_js_1.posts)
            .set({ state: 'QUEUED', scheduledAt: null })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, row.postId), (0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId), (0, drizzle_orm_1.inArray)(schema_js_1.posts.state, ['FAILED', 'PARTIAL', 'PUBLISHED', 'PUBLISHING'])));
        if (affectedRowsOf(flipped) === 0) {
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('وضعیت پست برای تلاش مجدد تغییر کرده است.'));
        }
        await tx.insert(schema_js_1.outboxEvents).values((0, outbox_js_1.outboxRow)({ aggregateType: 'post', aggregateId: row.postId, eventType: 'post.publish', payload: { retryTargetId: targetId } }));
    });
    // Fast path. Failure here is intentionally swallowed because the DB outbox is durable.
    try {
        await (0, queues_js_1.enqueue)('delivery', 'deliver', { targetId }, { jobId: `retry-manual:${targetId}:${(0, ids_js_1.newId)()}` });
    }
    catch {
        // Scheduler/outbox relay will recover the PENDING target when Redis is available.
    }
    await (0, audit_js_1.audit)({
        action: 'post.target.retry',
        actorId: meta.actorId ?? null,
        actorRole: meta.actorRole ?? null,
        subjectType: 'post_target',
        subjectId: targetId,
        ip: meta.ip ?? undefined,
    });
    return { ok: true };
}
async function deletePost(tenantId, id, meta = {}) {
    const db = (0, client_js_1.getDb)();
    const [existing] = await db
        .select({ id: schema_js_1.posts.id })
        .from(schema_js_1.posts)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, id), (0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId)))
        .limit(1);
    if (!existing) {
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پست'));
    }
    await db.transaction(async (tx) => {
        await tx.delete(schema_js_1.postTargets).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.postId, id), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.tenantId, tenantId)));
        await tx.delete(schema_js_1.posts).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, id), (0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId)));
    });
    await (0, audit_js_1.audit)({
        action: 'post.delete',
        actorId: meta.actorId ?? null,
        actorRole: meta.actorRole ?? null,
        subjectType: 'post',
        subjectId: id,
        ip: meta.ip ?? undefined,
    });
    return { ok: true };
}
async function deletePostsBulk(tenantId, filter, meta = {}) {
    const db = (0, client_js_1.getDb)();
    let targetPostIds = [];
    if (filter.ids && filter.ids.length > 0) {
        const owned = await db
            .select({ id: schema_js_1.posts.id })
            .from(schema_js_1.posts)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId), (0, drizzle_orm_1.inArray)(schema_js_1.posts.id, filter.ids)));
        targetPostIds = owned.map((p) => p.id);
    }
    else if (filter.state || (filter.olderThanDays && filter.olderThanDays > 0)) {
        const conditions = [(0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId)];
        if (filter.state) {
            conditions.push((0, drizzle_orm_1.eq)(schema_js_1.posts.state, filter.state));
        }
        if (filter.olderThanDays && filter.olderThanDays > 0) {
            const cutoff = new Date(Date.now() - filter.olderThanDays * 86400000);
            conditions.push((0, drizzle_orm_1.sql) `${schema_js_1.posts.createdAt} < ${cutoff}`);
        }
        const matched = await db
            .select({ id: schema_js_1.posts.id })
            .from(schema_js_1.posts)
            .where((0, drizzle_orm_1.and)(...conditions))
            .limit(500);
        targetPostIds = matched.map((p) => p.id);
    }
    if (targetPostIds.length === 0) {
        return { deletedCount: 0 };
    }
    await db.transaction(async (tx) => {
        await tx.delete(schema_js_1.postTargets).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.tenantId, tenantId), (0, drizzle_orm_1.inArray)(schema_js_1.postTargets.postId, targetPostIds)));
        await tx.delete(schema_js_1.posts).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId), (0, drizzle_orm_1.inArray)(schema_js_1.posts.id, targetPostIds)));
    });
    await (0, audit_js_1.audit)({
        action: 'post.bulk_delete',
        actorId: meta.actorId ?? undefined,
        actorRole: meta.actorRole ?? undefined,
        subjectType: 'post',
        subjectId: targetPostIds[0] ?? undefined,
        ip: meta.ip ?? undefined,
        meta: { count: targetPostIds.length },
    });
    return { deletedCount: targetPostIds.length };
}
/** mysql2/drizzle update result → affected rows (shape-safe, no `any`). */
function affectedRowsOf(result) {
    if (Array.isArray(result)) {
        const head = result[0];
        return typeof head?.affectedRows === 'number' ? head.affectedRows : 0;
    }
    const head = result;
    return typeof head?.affectedRows === 'number' ? head.affectedRows : 0;
}
