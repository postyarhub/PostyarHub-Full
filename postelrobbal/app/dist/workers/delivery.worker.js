"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startDeliveryWorker = startDeliveryWorker;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../db/client.js");
const schema_js_1 = require("../db/schema.js");
const errors_js_1 = require("../core/errors.js");
const delivery_state_js_1 = require("../core/delivery-state.js");
const post_aggregate_js_1 = require("../core/post-aggregate.js");
const outbox_js_1 = require("../core/outbox.js");
const events_js_1 = require("../core/events.js");
const logger_js_1 = require("../core/logger.js");
const delivery_buttons_js_1 = require("../core/delivery-buttons.js");
const media_service_js_1 = require("../modules/media/media.service.js");
const connection_js_1 = require("../queue/connection.js");
const env_js_1 = require("../config/env.js");
const queues_js_1 = require("../queue/queues.js");
const http_js_1 = require("../core/http.js");
const index_js_1 = require("../providers/index.js");
const encryption_js_1 = require("../security/encryption.js");
const types_js_1 = require("../providers/types.js");
const dispatcher_js_1 = require("./dispatcher.js");
/**
 * Delivery worker (§22, §84-88). One queue 'delivery', two job kinds:
 *   - deliver          {targetId}       → send a post_target to its channel
 *   - deliver-product  {payloadJson}    → transient wordpress product send
 * Duplicate-send protection: the PROCESSING claim is an atomic
 * UPDATE ... WHERE state IN ('PENDING','RETRYING') — losing updater exits.
 */
const log = (0, logger_js_1.createLogger)('delivery-worker');
const RETRY_CLASSES = new Set(['TRANSIENT', 'RATE_LIMITED']);
async function emitDeliveryEventSafely(input) {
    try {
        await (0, events_js_1.emitEvent)(input);
    }
    catch (err) {
        log.warn({ err, event: input.name, postId: input.props?.postId, targetId: input.props?.targetId }, 'delivery_analytics_event_failed');
    }
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function asString(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
function affectedRowsOf(result) {
    if (Array.isArray(result)) {
        const head = result[0];
        return typeof head?.affectedRows === 'number' ? head.affectedRows : 0;
    }
    const head = result;
    return typeof head?.affectedRows === 'number' ? head.affectedRows : 0;
}
function asProviderError(err) {
    if (err instanceof Error) {
        const candidate = err;
        if (typeof candidate.providerClass === 'string' && typeof candidate.userMessageFa === 'string')
            return candidate;
    }
    return null;
}
function errorClassOf(err) {
    const provider = asProviderError(err);
    if (provider)
        return provider.providerClass;
    if (err instanceof errors_js_1.AppError)
        return err.errorClass.toUpperCase();
    return 'UNKNOWN';
}
function errorMessageOf(err) {
    const provider = asProviderError(err);
    if (provider)
        return provider.userMessageFa;
    if (err instanceof errors_js_1.AppError)
        return err.userMessage;
    return 'ارسال پیام ناموفق بود.';
}
function providerDiagnosticOf(err) {
    const provider = asProviderError(err);
    const root = provider ? (provider.cause ?? provider) : err;
    const e = root instanceof Error ? root : new Error(String(root ?? 'unknown'));
    const cause = e.cause instanceof Error ? e.cause : e.cause;
    const c = cause && typeof cause === 'object' ? cause : null;
    const safeCode = typeof e.code === 'string' ? String(e.code) : null;
    const safeCauseCode = c && typeof c.code === 'string' ? c.code : null;
    const httpError = root && typeof root === 'object' && 'status' in root && 'contentType' in root && 'bodyPreview' in root
        ? root
        : null;
    return {
        providerClass: provider?.providerClass ?? null,
        errorName: e.name,
        errorCode: safeCode ?? safeCauseCode,
        errorMessage: String(e.message).slice(0, 180),
        causeName: c && typeof c.name === 'string' ? c.name : null,
        causeMessage: c && typeof c.message === 'string' ? c.message.slice(0, 180) : null,
        httpStatus: httpError && typeof httpError.status === 'number' ? httpError.status : null,
        httpContentType: httpError && typeof httpError.contentType === 'string' ? httpError.contentType.slice(0, 120) : null,
        httpBodyPreview: httpError && typeof httpError.bodyPreview === 'string'
            ? httpError.bodyPreview.replace(/[\r\n]+/g, ' ').slice(0, 240)
            : null,
    };
}
/** Platforms without parse-mode support receive plain text (§15: no emulation). */
function stripHtml(input) {
    return input
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function stripMarkdown(input) {
    return input
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
        .replace(/^\s*[-*_]{3,}\s*$/gm, '')
        .trim();
}
function escapeDestinationFooter(input, parseMode) {
    if (parseMode === 'HTML')
        return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (parseMode === 'MARKDOWN') {
        const markdownSpecial = new Set(['_', '*', '[', ']', '(', ')', '~', String.fromCharCode(96), '>', '#', '+', '-', '=', '|', '{', '}', '.', '!', '\\']);
        return Array.from(input, (char) => markdownSpecial.has(char) ? '\\' + char : char).join('');
    }
    return input;
}
async function claimTarget(targetId) {
    // Atomic claim — prevents duplicate sends when a job is retried/duplicated.
    const res = await (0, client_js_1.getDb)()
        .update(schema_js_1.postTargets)
        .set({ state: 'PROCESSING' })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, targetId), (0, drizzle_orm_1.inArray)(schema_js_1.postTargets.state, ['PENDING', 'RETRYING'])));
    return affectedRowsOf(res) > 0;
}
/**
 * After claiming a target, atomically reserve the parent post for delivery.
 * The post row lock is the same serialization boundary used by cancelPost():
 * either cancellation wins and the claimed target is cancelled, or the worker
 * wins and the post becomes PUBLISHING before any provider call can start.
 */
async function activateClaimedTarget(targetId, postId) {
    const db = (0, client_js_1.getDb)();
    return db.transaction(async (tx) => {
        const [post] = await tx.select({ state: schema_js_1.posts.state })
            .from(schema_js_1.posts)
            .where((0, drizzle_orm_1.eq)(schema_js_1.posts.id, postId))
            .limit(1)
            .for('update');
        if (!post || !['QUEUED', 'SCHEDULED', 'PUBLISHING'].includes(post.state)) {
            await tx.update(schema_js_1.postTargets)
                .set({ state: 'CANCELLED', nextRetryAt: null })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, targetId), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'PROCESSING')));
            return false;
        }
        if (post.state !== 'PUBLISHING') {
            await tx.update(schema_js_1.posts)
                .set({ state: 'PUBLISHING' })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, postId), (0, drizzle_orm_1.inArray)(schema_js_1.posts.state, ['QUEUED', 'SCHEDULED'])));
        }
        return true;
    });
}
async function loadActiveBotToken(channel) {
    if (!channel.botId)
        return null;
    const db = (0, client_js_1.getDb)();
    const [bot] = await db
        .select({ id: schema_js_1.bots.id, tokenEncrypted: schema_js_1.bots.tokenEncrypted })
        .from(schema_js_1.bots)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, channel.botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, channel.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, channel.platform), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE')))
        .limit(1);
    if (!bot)
        return null;
    return { token: (0, encryption_js_1.decryptSecret)(bot.tokenEncrypted), botId: bot.id };
}
async function resolveMediaForDelivery(tenantId, mediaId) {
    const db = (0, client_js_1.getDb)();
    const [m] = await db
        .select()
        .from(schema_js_1.media)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.media.id, mediaId), (0, drizzle_orm_1.eq)(schema_js_1.media.tenantId, tenantId)))
        .limit(1);
    if (!m)
        return null;
    if (!(m.mime.startsWith('image/') || m.mime === 'video/mp4'))
        return null;
    // Upload directly from the private worker storage to the provider. This
    // deliberately avoids asking Telegram/Bale to fetch a private PostYar URL.
    if (m.mime.startsWith('image/')) {
        return {
            buffer: await (0, media_service_js_1.readProviderPhotoJpeg)(m),
            kind: 'photo',
            mime: 'image/jpeg',
            filename: `postyar-${m.id}.jpg`,
        };
    }
    return {
        buffer: await (0, media_service_js_1.readMediaBuffer)(m),
        kind: 'video',
        mime: 'video/mp4',
        filename: `postyar-${m.id}.mp4`,
    };
}
async function deliverPost(targetId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({ target: schema_js_1.postTargets, post: schema_js_1.posts, channel: schema_js_1.channels })
        .from(schema_js_1.postTargets)
        .innerJoin(schema_js_1.posts, (0, drizzle_orm_1.eq)(schema_js_1.posts.id, schema_js_1.postTargets.postId))
        .innerJoin(schema_js_1.channels, (0, drizzle_orm_1.eq)(schema_js_1.channels.id, schema_js_1.postTargets.channelId))
        .where((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, targetId))
        .limit(1);
    if (!row) {
        log.warn({ targetId }, 'deliver_target_not_found');
        return;
    }
    const { target, post, channel } = row;
    if (!(await claimTargetSafe(targetId)))
        return;
    // The post-state transition is serialized under the parent-row lock so a
    // concurrent cancel cannot commit after our state check but before the
    // provider call. If cancellation wins, this function returns before send.
    if (!(await activateClaimedTarget(target.id, post.id))) {
        return;
    }
    await emitDeliveryEventSafely({
        name: 'post.delivery.started',
        tenantId: post.tenantId,
        subjectType: 'post_target',
        subjectId: target.id,
        props: { postId: post.id, channelId: channel.id, targetId: target.id, platform: channel.platform, attempts: target.attempts + 1 },
        analyticsDedupeKey: `delivery:started:${target.id}:${target.attempts + 1}`,
    });
    try {
        // Ownership guard: a DISABLED channel must never receive sends.
        if (channel.status === 'DISABLED') {
            await finalizeFailure(target, post, channel, 'CHANNEL_DISABLED', 'کانال غیرفعال است. آن را دوباره متصل کنید.', false);
            return;
        }
        const platform = channel.platform;
        let token;
        try {
            const bot = await loadActiveBotToken(channel);
            if (!bot) {
                const message = channel.botId
                    ? 'ربات متصل به این کانال فعال نیست یا دیگر وجود ندارد. ربات را فعال کنید یا کانال را دوباره متصل کنید.'
                    : 'ربات فعالی برای این پلتفرم یافت نشد. ابتدا ربات را متصل کنید.';
                await finalizeFailure(target, post, channel, 'NO_BOT', message, false);
                return;
            }
            token = bot.token;
        }
        catch {
            await finalizeFailure(target, post, channel, 'UNAUTHORIZED', 'اعتبارنامهٔ ربات نامعتبر است. ربات را دوباره متصل کنید.', false);
            return;
        }
        const provider = (0, index_js_1.getProvider)(platform);
        const caps = provider.capabilities();
        const buttons = post.buttonsJson ?? {};
        // Parse mode: strip markup for platforms without parse support.
        let text = post.body;
        let parseMode = post.parseMode;
        if (!caps.htmlParseMode) {
            if (parseMode === 'HTML') {
                text = stripHtml(text);
                parseMode = 'NONE';
            }
            else if (parseMode === 'MARKDOWN') {
                text = stripMarkdown(text);
                parseMode = 'NONE';
            }
        }
        // Per-channel suffixes are appended only for this target.
        const destinationFooterValue = buttons.footerByChannel?.[channel.id];
        const destinationFooter = typeof destinationFooterValue === 'string'
            ? destinationFooterValue.trim()
            : '';
        if (destinationFooter) {
            const footerText = escapeDestinationFooter(destinationFooter, parseMode);
            const baseText = text.trimEnd();
            const separator = parseMode === 'HTML' ? '<br><br>' : '\n\n';
            const finalText = baseText ? baseText + separator + footerText : footerText;
            if (finalText.length > 4000) {
                await finalizeFailure(target, post, channel, 'POST_TEXT_TOO_LONG', 'مجموع متن پست و متن انتهایی اختصاصی از حد ۴۰۰۰ نویسه بیشتر است.', false);
                return;
            }
            text = finalText;
        }
        // Destination-specific buttons override platform defaults; legacy post shapes remain supported.
        const channelButtons = buttons.byChannel?.[channel.id];
        const platformButtons = buttons.byPlatform?.[platform];
        let inline = channelButtons !== undefined
            ? channelButtons
            : platformButtons !== undefined
                ? platformButtons
                : [...(buttons.inline ?? []), ...(buttons.links ?? []).map((l) => ({ label: l.label, url: l.url }))];
        if (!caps.inlineButtons)
            inline = [];
        // Normalize before enforcing the provider limit, and collapse identical
        // destinations. Legacy posts can contain the same button in both `inline`
        // and `links`; without this guard that URL is exposed more than once.
        const inlineButtons = caps.inlineButtons
            ? (0, delivery_buttons_js_1.resolveUniqueDeliveryButtons)(platform, inline)
            : [];
        // Preserve old records through the legacy mediaId fallback while the ordered
        // collection is used for new multi-image posts.
        const mediaIds = Array.isArray(post.mediaIds) && post.mediaIds.length > 0
            ? [...new Set(post.mediaIds)]
            : post.mediaId ? [post.mediaId] : [];
        const mediaPayloads = [];
        if (mediaIds.length > 0) {
            if (!caps.sendMedia) {
                await finalizeFailure(target, post, channel, 'UNSUPPORTED_MEDIA', 'پلتفرم مقصد از ارسال این نوع رسانه پشتیبانی نمی‌کند.', false);
                return;
            }
            if (mediaIds.length > 10) {
                await finalizeFailure(target, post, channel, 'MEDIA_COUNT_INVALID', 'تعداد تصاویر این پست بیش از حد مجاز است؛ پست را اصلاح کنید.', false);
                return;
            }
            for (const mediaId of mediaIds) {
                const payload = await resolveMediaForDelivery(post.tenantId, mediaId);
                if (!payload) {
                    await finalizeFailure(target, post, channel, 'MEDIA_UNAVAILABLE', 'یکی از رسانه‌های پیوست‌شده دیگر قابل دسترسی یا قابل انتشار نیست.', false);
                    return;
                }
                mediaPayloads.push(payload);
            }
            if (mediaPayloads.length > 1 && mediaPayloads.some((item) => item.kind !== 'photo')) {
                await finalizeFailure(target, post, channel, 'MEDIA_MIX_INVALID', 'ارسال چندرسانه‌ای فقط برای مجموعه‌ای از تصاویر پشتیبانی می‌شود؛ ویدئو را جداگانه ارسال کنید.', false);
                return;
            }
            const totalBytes = mediaPayloads.reduce((sum, item) => sum + item.buffer.length, 0);
            if (totalBytes > 20 * 1024 * 1024) {
                await finalizeFailure(target, post, channel, 'MEDIA_ALBUM_TOO_LARGE', 'حجم مجموع تصاویر پس از آماده‌سازی بیش از ۲۰ مگابایت است؛ تعداد یا حجم تصاویر را کاهش دهید.', false);
                return;
            }
        }
        let result;
        if (mediaPayloads.length === 0) {
            result = await provider.sendText(token, { chatRef: channel.channelRef, text, parseMode, inlineButtons });
        }
        else if (mediaPayloads.length >= 2 &&
            mediaPayloads.every((item) => item.kind === 'photo') &&
            typeof provider.sendMediaGroup === 'function') {
            // Telegram and Bale expose the Bot API media-group endpoint. Provider
            // adapters attach configured inline buttons to the album's first message.
            // text in a separate text message because album captions are limited to 1024 chars.
            result = await provider.sendMediaGroup(token, {
                chatRef: channel.channelRef,
                text: text.length <= 1024 ? text : '',
                parseMode,
                inlineButtons,
                media: mediaPayloads.map((item) => ({
                    buffer: item.buffer,
                    filename: item.filename,
                    mime: item.mime,
                })),
            });
            if (text.length > 1024) {
                try {
                    await provider.sendText(token, { chatRef: channel.channelRef, text, parseMode, inlineButtons: [] });
                }
                catch (err) {
                    // Do not auto-retry and duplicate an album already accepted by the provider.
                    throw (0, types_js_1.makeProviderError)('UNKNOWN', 'تصاویر ارسال شدند، اما ارسال متن بلند کامل نشد؛ وضعیت کانال را بررسی کنید.', err);
                }
            }
        }
        else if (mediaPayloads.length === 1) {
            const item = mediaPayloads[0];
            result = await provider.sendMedia(token, {
                chatRef: channel.channelRef,
                text,
                parseMode,
                inlineButtons,
                mediaBuffer: item.buffer,
                mediaFilename: item.filename,
                mediaMime: item.mime,
                kind: item.kind,
            });
        }
        else {
            // Send each image through the provider's single-file method, attaching
            // the caption/buttons only to the first image. Bale bypasses sendMediaGroup
            // above so every photo remains a standalone message in the Bale client.
            let firstResult = null;
            for (let index = 0; index < mediaPayloads.length; index += 1) {
                const item = mediaPayloads[index];
                try {
                    const sent = await provider.sendMedia(token, {
                        chatRef: channel.channelRef,
                        text: index === 0 && text.length <= 1024 ? text : '',
                        parseMode: index === 0 && text.length <= 1024 ? parseMode : 'NONE',
                        inlineButtons: index === 0 ? inlineButtons : [],
                        mediaBuffer: item.buffer,
                        mediaFilename: item.filename,
                        mediaMime: item.mime,
                        kind: item.kind,
                    });
                    if (index === 0)
                        firstResult = sent;
                }
                catch (err) {
                    if (index === 0)
                        throw err;
                    // Some earlier items have already been sent. Failing non-retryably
                    // prevents the worker from blindly re-sending duplicate media.
                    throw (0, types_js_1.makeProviderError)('UNKNOWN', 'بخشی از تصاویر ارسال شد، اما ارسال همهٔ تصاویر کامل نشد؛ وضعیت کانال را بررسی کنید.', err);
                }
            }
            if (text.length > 1024) {
                try {
                    await provider.sendText(token, { chatRef: channel.channelRef, text, parseMode, inlineButtons: [] });
                }
                catch (err) {
                    throw (0, types_js_1.makeProviderError)('UNKNOWN', 'تصاویر ارسال شدند، اما ارسال متن بلند کامل نشد؛ وضعیت کانال را بررسی کنید.', err);
                }
            }
            if (!firstResult)
                throw (0, types_js_1.makeProviderError)('UNKNOWN', 'پلتفرم شناسهٔ پیام معتبر برنگرداند.');
            result = firstResult;
        }
        await finalizeSuccess(target, post, channel, platform, result.messageId);
    }
    catch (err) {
        const errorClass = errorClassOf(err);
        const message = errorMessageOf(err);
        const retryable = RETRY_CLASSES.has(errorClass);
        log.error({
            targetId: target.id,
            postId: post.id,
            channelId: channel.id,
            platform: channel.platform,
            errorClass,
            retryable,
            diagnostic: providerDiagnosticOf(err),
        }, 'delivery_attempt_failed');
        await finalizeFailure(target, post, channel, errorClass, message, retryable, asProviderError(err)?.retryAfterMs);
    }
}
async function claimTargetSafe(targetId) {
    const claimed = await claimTarget(targetId);
    if (!claimed)
        log.debug({ targetId }, 'deliver_target_already_claimed');
    return claimed;
}
async function publishScheduledPost(postId, scheduledAtIso) {
    const db = (0, client_js_1.getDb)();
    const now = new Date();
    let published = false;
    await db.transaction(async (tx) => {
        const [post] = await tx
            .select({ id: schema_js_1.posts.id, state: schema_js_1.posts.state, scheduledAt: schema_js_1.posts.scheduledAt })
            .from(schema_js_1.posts)
            .where((0, drizzle_orm_1.eq)(schema_js_1.posts.id, postId))
            .limit(1)
            .for('update');
        if (!post || post.state !== 'SCHEDULED')
            return;
        if (!post.scheduledAt || post.scheduledAt.getTime() > now.getTime())
            return;
        const flipped = await tx
            .update(schema_js_1.posts)
            .set({ state: 'QUEUED' })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, postId), (0, drizzle_orm_1.eq)(schema_js_1.posts.state, 'SCHEDULED')));
        if (affectedRowsOf(flipped) === 0)
            return;
        await tx.insert(schema_js_1.outboxEvents).values((0, outbox_js_1.outboxRow)({ aggregateType: 'post', aggregateId: postId, eventType: 'post.publish', payload: { scheduledAt: scheduledAtIso ?? post.scheduledAt.toISOString() } }));
        published = true;
    });
    if (published) {
        await (0, outbox_js_1.relayOutbox)(dispatcher_js_1.outboxDispatcher);
        log.info({ postId, scheduledAt: scheduledAtIso ?? null }, 'scheduled_post_released');
    }
}
async function finalizeSuccess(target, post, channel, platform, messageId, wordpressMeta) {
    const now = new Date();
    const db = (0, client_js_1.getDb)();
    let applied = false;
    await db.transaction(async (tx) => {
        const updated = await tx
            .update(schema_js_1.postTargets)
            .set({
            state: 'SENT',
            providerMessageId: messageId.slice(0, 190),
            sentAt: now,
            attempts: target.attempts + 1,
            errorCode: null,
            errorMessage: null,
            nextRetryAt: null,
        })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, target.id), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'PROCESSING')));
        if (affectedRowsOf(updated) === 0)
            return;
        applied = true;
        // WordPress metadata must commit in the same transaction as the target's
        // successful terminal transition. This prevents "sent but not recorded"
        // windows that could otherwise cause campaign duplicates on the next run.
        if (wordpressMeta) {
            if (wordpressMeta.itemType === 'product') {
                await tx
                    .update(schema_js_1.wordpressProducts)
                    .set({ lastPublishedAt: now })
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.siteId, wordpressMeta.siteId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.tenantId, post.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.wcProductId, wordpressMeta.itemId)));
            }
            else {
                await tx
                    .update(schema_js_1.wordpressContents)
                    .set({ lastPublishedAt: now })
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.siteId, wordpressMeta.siteId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.tenantId, post.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.contentId, wordpressMeta.itemId)));
            }
            if (wordpressMeta.campaignId) {
                const [campaign] = await tx
                    .select({ sentIdsJson: schema_js_1.wordpressCampaigns.sentIdsJson })
                    .from(schema_js_1.wordpressCampaigns)
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.id, wordpressMeta.campaignId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.tenantId, post.tenantId)))
                    .limit(1)
                    .for('update');
                if (campaign) {
                    const current = Array.isArray(campaign.sentIdsJson)
                        ? campaign.sentIdsJson.map((value) => Number(value)).filter(Number.isFinite)
                        : [];
                    if (!current.includes(wordpressMeta.itemId)) {
                        await tx
                            .update(schema_js_1.wordpressCampaigns)
                            .set({ sentIdsJson: [...current, wordpressMeta.itemId].slice(-5000) })
                            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.id, wordpressMeta.campaignId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.tenantId, post.tenantId)));
                    }
                }
            }
        }
    });
    if (!applied) {
        // Scheduler/maintenance may have terminally reaped a long-running job.
        // A late provider response must never resurrect that terminal decision.
        log.warn({ targetId: target.id, postId: post.id }, 'delivery_stale_success_ignored');
        return false;
    }
    await db
        .update(schema_js_1.channels)
        .set({ status: 'ACTIVE', lastVerifiedAt: now, healthJson: { ok: true, verifiedVia: 'first_send' } })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.id, channel.id), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'PENDING_VERIFY')));
    await (0, post_aggregate_js_1.refreshPostAggregate)(post.id);
    await emitDeliveryEventSafely({
        name: 'post.sent',
        tenantId: post.tenantId,
        subjectType: 'post',
        subjectId: post.id,
        props: { channelId: channel.id, targetId: target.id, platform },
    });
    await emitDeliveryEventSafely({
        name: 'post.delivery.sent',
        tenantId: post.tenantId,
        subjectType: 'post_target',
        subjectId: target.id,
        props: { postId: post.id, channelId: channel.id, targetId: target.id, platform, attempts: target.attempts + 1, campaignId: wordpressMeta?.campaignId ?? null },
        analyticsDedupeKey: `delivery:sent:${target.id}:${messageId.slice(0, 80)}`,
    });
    if (wordpressMeta) {
        const baseProps = {
            tenantId: post.tenantId,
            siteId: wordpressMeta.siteId,
            itemId: wordpressMeta.itemId,
            campaignId: wordpressMeta.campaignId ?? null,
            postId: post.id,
            targetId: target.id,
            channelId: channel.id,
            platform,
        };
        if (wordpressMeta.itemType === 'product') {
            await emitDeliveryEventSafely({
                name: 'wordpress.product.published',
                tenantId: post.tenantId,
                subjectType: 'wordpress_product',
                subjectId: `${wordpressMeta.siteId}:${wordpressMeta.itemId}`,
                props: baseProps,
            });
        }
        else {
            await emitDeliveryEventSafely({
                name: 'wordpress.content.published',
                tenantId: post.tenantId,
                subjectType: 'wordpress_content',
                subjectId: `${wordpressMeta.siteId}:${wordpressMeta.itemId}`,
                props: baseProps,
            });
        }
    }
    return true;
}
async function finalizeFailure(target, post, channel, errorCode, messageFa, retryable, retryAfterMs, campaignId) {
    const attempts = target.attempts + 1;
    let nextRetryAt = null;
    let state = 'FAILED';
    if (retryable) {
        const policyDelaySeconds = (0, delivery_state_js_1.nextRetryDelaySeconds)(attempts);
        const providerDelaySeconds = Number.isFinite(retryAfterMs) && (retryAfterMs ?? 0) > 0
            ? Math.ceil(retryAfterMs / 1000)
            : null;
        const delaySeconds = providerDelaySeconds !== null
            ? Math.max(providerDelaySeconds, policyDelaySeconds ?? 0)
            : policyDelaySeconds;
        if (delaySeconds !== null) {
            state = 'RETRYING';
            nextRetryAt = new Date(Date.now() + Math.min(3_600, Math.max(1, delaySeconds)) * 1000);
        }
    }
    const updated = await (0, client_js_1.getDb)()
        .update(schema_js_1.postTargets)
        .set({ state, attempts, nextRetryAt, errorCode: errorCode.slice(0, 80), errorMessage: messageFa.slice(0, 250) })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, target.id), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'PROCESSING')));
    if (affectedRowsOf(updated) === 0) {
        // A stale worker completion must not overwrite a scheduler/maintenance
        // terminal decision or generate misleading failure analytics.
        log.warn({ targetId: target.id, postId: post.id, errorCode }, 'delivery_stale_failure_ignored');
        return;
    }
    // Failed chat lookups are recorded as channel health, without auto-disabling.
    if (errorCode === 'NOT_FOUND' || errorCode === 'BLOCKED') {
        await (0, client_js_1.getDb)()
            .update(schema_js_1.channels)
            .set({ healthJson: { ok: false, errorCode, checkedAt: new Date().toISOString() } })
            .where((0, drizzle_orm_1.eq)(schema_js_1.channels.id, channel.id));
    }
    await (0, post_aggregate_js_1.refreshPostAggregate)(post.id);
    // Schedule the retry directly in BullMQ as the primary retry clock. The
    // database state remains authoritative and the scheduler/worker recovery
    // lanes remain fallbacks if Redis is unavailable at this exact moment. A
    // conditional PROCESSING -> RETRYING transition plus the stable attempt job
    // id prevents an overlapping recovery tick from sending twice.
    if (state === 'RETRYING' && nextRetryAt) {
        try {
            await (0, queues_js_1.enqueue)('delivery', 'deliver', { targetId: target.id }, { jobId: `retry:${target.id}:${attempts}`, delayMs: Math.max(0, nextRetryAt.getTime() - Date.now()) });
        }
        catch (err) {
            log.warn({ err, targetId: target.id, attempts }, 'delivery_retry_schedule_failed');
        }
    }
    await emitDeliveryEventSafely({
        name: 'post.failed',
        tenantId: post.tenantId,
        subjectType: 'post',
        subjectId: post.id,
        props: { channelId: channel.id, targetId: target.id, platform: channel.platform, errorCode, retrying: state === 'RETRYING', attempts, campaignId: campaignId ?? null },
    });
    await emitDeliveryEventSafely({
        name: 'post.delivery.failed',
        tenantId: post.tenantId,
        subjectType: 'post_target',
        subjectId: target.id,
        props: { postId: post.id, channelId: channel.id, targetId: target.id, platform: channel.platform, errorCode, retrying: state === 'RETRYING', attempts, nextRetryAt: nextRetryAt?.toISOString() ?? null, campaignId: campaignId ?? null },
        analyticsDedupeKey: `delivery:failed:${target.id}:${attempts}:${errorCode}`,
    });
}
function parseWordPressPayload(payload) {
    const tenantId = asString(payload.tenantId);
    const siteId = asString(payload.siteId);
    const channelId = asString(payload.channelId);
    const rawItemId = payload.itemId ?? payload.productId ?? payload.contentId;
    const itemId = typeof rawItemId === 'number' ? rawItemId : typeof rawItemId === 'string' ? Number(rawItemId) : NaN;
    const rawType = asString(payload.itemType);
    const itemType = rawType === 'content' ? 'content' : 'product';
    const body = asString(payload.body);
    if (!tenantId || !siteId || !channelId || !Number.isFinite(itemId) || !body)
        return null;
    return {
        tenantId,
        postId: asString(payload.postId),
        targetId: asString(payload.targetId),
        siteId,
        itemType,
        itemId,
        channelId,
        title: asString(payload.title) ?? '',
        body,
        imageUrl: asString(payload.imageUrl),
        campaignId: asString(payload.campaignId),
    };
}
async function deliverWordPress(payload) {
    const db = (0, client_js_1.getDb)();
    const input = parseWordPressPayload(payload);
    if (!input) {
        log.warn({ payloadKeys: Object.keys(payload) }, 'deliver_wordpress_invalid_payload');
        return;
    }
    let target = null;
    let post = null;
    let channel = null;
    // Current WordPress publish/campaign events carry the canonical target. Claim
    // it before any provider call so duplicate jobs cannot double-send. Legacy
    // outbox rows without targetId remain supported as a compatibility path.
    if (input.targetId) {
        const [row] = await db
            .select({ target: schema_js_1.postTargets, post: schema_js_1.posts, channel: schema_js_1.channels })
            .from(schema_js_1.postTargets)
            .innerJoin(schema_js_1.posts, (0, drizzle_orm_1.eq)(schema_js_1.posts.id, schema_js_1.postTargets.postId))
            .innerJoin(schema_js_1.channels, (0, drizzle_orm_1.eq)(schema_js_1.channels.id, schema_js_1.postTargets.channelId))
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, input.targetId), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.tenantId, input.tenantId)))
            .limit(1);
        if (!row) {
            log.warn({ targetId: input.targetId }, 'deliver_wordpress_target_not_found');
            return;
        }
        target = row.target;
        post = row.post;
        channel = row.channel;
        if (target.channelId !== input.channelId || post.id !== input.postId) {
            log.error({ targetId: target.id, payloadChannelId: input.channelId, targetChannelId: target.channelId, payloadPostId: input.postId, targetPostId: post.id }, 'deliver_wordpress_target_payload_mismatch');
            await db
                .update(schema_js_1.postTargets)
                .set({ state: 'FAILED', attempts: target.attempts + 1, errorCode: 'TARGET_PAYLOAD_MISMATCH', errorMessage: 'دادهٔ انتشار معتبر نیست.', nextRetryAt: null })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.id, target.id), (0, drizzle_orm_1.inArray)(schema_js_1.postTargets.state, ['PENDING', 'RETRYING'])));
            return;
        }
        if (!(await claimTargetSafe(target.id)))
            return;
        if (!(await activateClaimedTarget(target.id, post.id)))
            return;
    }
    if (!channel) {
        const channelRows = await db
            .select()
            .from(schema_js_1.channels)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.id, input.channelId), (0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, input.tenantId)))
            .limit(1);
        channel = channelRows[0] ?? null;
    }
    if (!channel || channel.status !== 'ACTIVE') {
        log.warn({ channelId: input.channelId, targetId: input.targetId ?? null }, 'deliver_wordpress_channel_inactive');
        if (target && post && channel) {
            await finalizeFailure(target, post, channel, 'CHANNEL_DISABLED', 'کانال غیرفعال است. آن را دوباره متصل کنید.', false, undefined, input.campaignId);
        }
        return;
    }
    let token = null;
    try {
        const bot = await loadActiveBotToken(channel);
        token = bot?.token ?? null;
    }
    catch {
        token = null;
    }
    if (!token) {
        log.warn({ channelId: input.channelId, targetId: input.targetId ?? null }, 'deliver_wordpress_no_bot');
        if (target && post) {
            await finalizeFailure(target, post, channel, 'NO_BOT', 'ربات فعال برای این کانال یافت نشد. ربات را فعال کنید یا کانال را دوباره متصل کنید.', false, undefined, input.campaignId);
        }
        return;
    }
    const provider = (0, index_js_1.getProvider)(channel.platform);
    const caps = provider.capabilities();
    let text = input.title ? `${input.title}\n\n${input.body}` : input.body;
    if (!caps.htmlParseMode)
        text = stripHtml(text);
    try {
        if (input.imageUrl) {
            if (!caps.sendMedia) {
                if (target && post) {
                    await finalizeFailure(target, post, channel, 'UNSUPPORTED_MEDIA', 'پلتفرم مقصد از ارسال تصویر پشتیبانی نمی‌کند.', false, undefined, input.campaignId);
                }
                return;
            }
            await (0, http_js_1.assertSafeUrl)(input.imageUrl);
        }
        const result = input.imageUrl && caps.sendMedia
            ? await provider.sendMedia(token, {
                chatRef: channel.channelRef,
                text,
                parseMode: 'NONE',
                mediaUrl: input.imageUrl,
                kind: 'photo',
            })
            : await provider.sendText(token, { chatRef: channel.channelRef, text, parseMode: 'NONE' });
        if (target && post) {
            const applied = await finalizeSuccess(target, post, channel, channel.platform, result.messageId, {
                siteId: input.siteId,
                itemType: input.itemType,
                itemId: input.itemId,
                campaignId: input.campaignId,
            });
            if (!applied)
                return;
            return;
        }
        // Legacy WordPress event path has no durable post_target. Keep it functional
        // but do not claim a provider delivery state that cannot be persisted.
        await emitDeliveryEventSafely({
            name: input.itemType === 'product' ? 'wordpress.product.published' : 'wordpress.content.published',
            tenantId: input.tenantId,
            subjectType: input.itemType === 'product' ? 'wordpress_product' : 'wordpress_content',
            subjectId: `${input.siteId}:${input.itemId}`,
            props: { tenantId: input.tenantId, siteId: input.siteId, itemId: input.itemId, channelId: channel.id, platform: channel.platform, legacyDelivery: true },
        });
    }
    catch (err) {
        const errorClass = errorClassOf(err);
        const message = errorMessageOf(err);
        const retryable = RETRY_CLASSES.has(errorClass);
        log.error({
            targetId: input.targetId ?? null,
            postId: input.postId ?? null,
            channelId: channel.id,
            platform: channel.platform,
            errorClass,
            retryable,
            diagnostic: providerDiagnosticOf(err),
        }, 'wordpress_delivery_attempt_failed');
        if (target && post) {
            await finalizeFailure(target, post, channel, errorClass, message, retryable, asProviderError(err)?.retryAfterMs, input.campaignId);
            return;
        }
        throw err;
    }
}
async function processJob(job) {
    const data = asRecord(job.data);
    if (job.name === 'publish-scheduled') {
        const postId = data ? asString(data.postId) : null;
        if (!postId) {
            log.warn({ jobId: job.id }, 'scheduled_publish_job_missing_post');
            return;
        }
        await publishScheduledPost(postId, data && typeof data.scheduledAt === 'string' ? data.scheduledAt : null);
        return;
    }
    if (job.name === 'deliver') {
        const targetId = data ? asString(data.targetId) : null;
        if (!targetId) {
            log.warn({ jobId: job.id }, 'deliver_job_missing_target');
            return;
        }
        await deliverPost(targetId);
        return;
    }
    if (job.name === 'deliver-product') {
        const payload = data ? asRecord(data.payloadJson) : null;
        if (!payload) {
            log.warn({ jobId: job.id }, 'deliver_wordpress_job_missing_payload');
            return;
        }
        await deliverWordPress(payload);
        return;
    }
    log.warn({ jobName: job.name }, 'unknown_delivery_job');
}
function startDeliveryWorker() {
    const env = (0, env_js_1.loadEnv)();
    log.info({ concurrency: env.WORKER_CONCURRENCY }, 'delivery_worker_starting');
    // createWorker's processor parameter resolves to `never` due to a broken
    // conditional type in queue/connection.ts — bridge it without losing typing.
    const processor = async (job) => {
        try {
            await processJob(job);
        }
        catch (err) {
            // BullMQ retries (attempts=3); classified failures above never throw.
            log.error({ err, jobId: job.id, jobName: job.name }, 'delivery_job_failed');
            throw err;
        }
    };
    return (0, connection_js_1.createWorker)('delivery', processor, {
        concurrency: env.WORKER_CONCURRENCY,
    });
}
