"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startBotEventWorker = startBotEventWorker;
const node_crypto_1 = require("node:crypto");
const drizzle_orm_1 = require("drizzle-orm");
const connection_js_1 = require("../queue/connection.js");
const client_js_1 = require("../db/client.js");
const schema_js_1 = require("../db/schema.js");
const ids_js_1 = require("../core/ids.js");
const encryption_js_1 = require("../security/encryption.js");
const index_js_1 = require("../providers/index.js");
const events_js_1 = require("../core/events.js");
const logger_js_1 = require("../core/logger.js");
const delivery_js_1 = require("../modules/notifications/delivery.js");
const bot_message_js_1 = require("../core/bot-message.js");
const ai_service_js_1 = require("../modules/ai/ai.service.js");
const env_js_1 = require("../config/env.js");
const bot_routing_js_1 = require("../core/bot-routing.js");
const button_target_js_1 = require("../core/button-target.js");
const workflow_engine_js_1 = require("../modules/workflows/workflow.engine.js");
/**
 * Bot event processor: consumes deduplicated bot_events (§187), upserts
 * bot_users, matches commands/keywords/workflows and answers through the
 * platform provider. Auto-reply AI is called DIRECTLY here (30s hard timeout
 * inside the provider layer) — never via the ai-jobs queue — with quota
 * counted through consumeAiQuota.
 */
const DEFAULT_AI_PROMPT_FA = 'شما پاسخ‌گوی خودکار یک کسب‌وکار ایرانی هستید. کوتاه، مؤدبانه و فارسی پاسخ بده. اگر پاسخ را نمی‌دانی، کاربر را به پشتیبانی ارجاع بده.';
const AI_FALLBACK_FA = 'در پاسخ‌گویی خودکار خطایی رخ داد. لطفاً بعداً دوباره پیام بدهید.';
const SPAM_WINDOW_MS = 3_600_000; // §191: 20 outbound messages per chat per hour
const SPAM_MAX_PER_WINDOW = 20;
async function ensureConversation(bot, chatRef, platformUserId) {
    const db = (0, client_js_1.getDb)();
    const normalizedUser = platformUserId ?? '';
    const id = (0, ids_js_1.newId)();
    await db.insert(schema_js_1.botConversations).values({
        id, tenantId: bot.tenantId, botId: bot.id, platform: bot.platform, chatRef, platformUserId: normalizedUser, lastActivityAt: new Date(),
    }).onDuplicateKeyUpdate({ set: { lastActivityAt: new Date() } });
    const [conversation] = await db
        .select({ id: schema_js_1.botConversations.id })
        .from(schema_js_1.botConversations)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botConversations.tenantId, bot.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.botConversations.botId, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.botConversations.platform, bot.platform), (0, drizzle_orm_1.eq)(schema_js_1.botConversations.chatRef, chatRef), (0, drizzle_orm_1.eq)(schema_js_1.botConversations.platformUserId, normalizedUser)))
        .limit(1);
    if (!conversation)
        throw new Error('BOT_CONVERSATION_CREATE_FAILED');
    return conversation.id;
}
function coerceButtons(value) {
    if (!Array.isArray(value))
        return undefined;
    const buttons = [];
    for (const raw of value.slice(0, 8)) {
        if (!raw || typeof raw !== 'object')
            continue;
        const b = raw;
        if (typeof b['label'] !== 'string' || !b['label'])
            continue;
        let safeUrl;
        if (typeof b['url'] === 'string') {
            try {
                safeUrl = (0, button_target_js_1.normalizeButtonTargetValue)('URL', b['url'].slice(0, 255));
            }
            catch { /* discard legacy unsafe URL */ }
        }
        const callback = typeof b['callback'] === 'string' ? b['callback'].slice(0, 64) : undefined;
        if (!safeUrl && !callback)
            continue;
        buttons.push({
            label: b['label'].slice(0, 64),
            ...(safeUrl ? { url: safeUrl } : {}),
            ...(callback ? { callback } : {}),
        });
    }
    return buttons.length ? buttons : undefined;
}
function startBotEventWorker() {
    const log = (0, logger_js_1.createLogger)('bot-event-worker');
    // Shared Redis sliding-window limiter survives worker restarts and prevents
    // a second worker process from independently resetting the per-chat ceiling.
    const spamAllowed = async (key) => {
        const now = Date.now();
        const digest = (0, node_crypto_1.createHash)('sha256').update(key).digest('hex');
        const redisKey = `postyar:bot-event-spam:${digest}`;
        const script = [
            "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1] - ARGV[2])",
            'local used = redis.call("ZCARD", KEYS[1])',
            'if used >= tonumber(ARGV[3]) then return 0 end',
            'redis.call("ZADD", KEYS[1], ARGV[1], ARGV[4])',
            'redis.call("PEXPIRE", KEYS[1], ARGV[2])',
            'return 1',
        ].join('\n');
        try {
            const allowed = Number(await (0, connection_js_1.getRedis)().eval(script, 1, redisKey, String(now), String(SPAM_WINDOW_MS), String(SPAM_MAX_PER_WINDOW), `${now}:${(0, ids_js_1.newId)()}`));
            return allowed === 1;
        }
        catch (err) {
            // Fail closed if the shared abuse-control store is unavailable.
            log.error({ errorName: err instanceof Error ? err.name : 'Error' }, 'bot_spam_control_unavailable');
            return false;
        }
    };
    // One failure notification per bot per hour (in-memory guard).
    const lastNotifyAt = new Map();
    const shouldNotify = (botId) => {
        const now = Date.now();
        const last = lastNotifyAt.get(botId) ?? 0;
        if (now - last < SPAM_WINDOW_MS)
            return false;
        lastNotifyAt.set(botId, now);
        return true;
    };
    const makeSend = (bot, token, expectedChatRef, platformUserId) => {
        const provider = (0, index_js_1.getProvider)(bot.platform);
        const caps = provider.capabilities();
        return async (chatRef, text, buttons) => {
            try {
                (0, bot_routing_js_1.assertBotReplyRoute)({ botId: bot.id, platform: bot.platform, chatRef: expectedChatRef }, { botId: bot.id, platform: bot.platform, chatRef });
            }
            catch (err) {
                log.error({ botId: bot.id, platform: bot.platform, expectedChatRef, attemptedChatRef: chatRef, error: err instanceof Error ? err.message : String(err) }, 'bot_cross_route_blocked');
                throw err;
            }
            if (!(await spamAllowed(`${bot.id}:${chatRef}`))) {
                log.warn({ botId: bot.id, chatRef }, 'bot_spam_control_drop');
                return;
            }
            const inline = caps.inlineButtons ? buttons : undefined;
            const conversationId = await ensureConversation(bot, chatRef, platformUserId);
            let result;
            try {
                result = await provider.sendText(token, {
                    chatRef,
                    text: text.slice(0, 4000),
                    ...(inline && inline.length ? { inlineButtons: inline } : {}),
                });
            }
            catch (err) {
                await (0, client_js_1.getDb)().insert(schema_js_1.botMessages).values({
                    id: (0, ids_js_1.newId)(), tenantId: bot.tenantId, botId: bot.id, conversationId, platform: bot.platform, direction: 'OUTBOUND',
                    platformMessageId: null, senderRef: bot.id, text: text.slice(0, 4000), status: 'FAILED',
                }).catch(() => undefined);
                throw err;
            }
            await (0, client_js_1.getDb)().insert(schema_js_1.botMessages).values({
                id: (0, ids_js_1.newId)(), tenantId: bot.tenantId, botId: bot.id, conversationId, platform: bot.platform, direction: 'OUTBOUND',
                platformMessageId: result.messageId ?? null, senderRef: bot.id, text: text.slice(0, 4000), status: 'SENT',
            });
            await (0, events_js_1.emitEvent)({
                name: 'bot.message.sent',
                tenantId: bot.tenantId,
                subjectType: 'bot',
                subjectId: bot.id,
                props: { botId: bot.id, platform: bot.platform },
            });
        };
    };
    const respond = async (bot, responseKind, payload, userText, chatRef, send, platformUserId) => {
        const text = typeof payload?.['text'] === 'string' ? payload['text'] : '';
        switch (responseKind) {
            case 'TEXT': {
                if (text)
                    await send(chatRef, text);
                return;
            }
            case 'BUTTONS': {
                if (!text)
                    return;
                await send(chatRef, text, coerceButtons(payload?.['buttons']));
                return;
            }
            case 'AI': {
                const custom = typeof payload?.['systemPrompt'] === 'string' ? payload['systemPrompt'] : '';
                const system = custom || bot.aiSystemPrompt || DEFAULT_AI_PROMPT_FA;
                try {
                    // Direct provider call (30s timeout) — quota counted inside aiProviderComplete.
                    const reply = await (0, ai_service_js_1.aiProviderComplete)(bot.tenantId, system, userText.slice(0, 2000) || 'سلام');
                    await send(chatRef, reply);
                }
                catch (err) {
                    log.warn({ botId: bot.id, err: err instanceof Error ? err.message : 'ai_error' }, 'bot_ai_reply_failed');
                    await send(chatRef, AI_FALLBACK_FA);
                }
                return;
            }
            case 'WORKFLOW': {
                const workflowId = typeof payload?.['workflowId'] === 'string' ? payload['workflowId'] : '';
                if (!workflowId)
                    return;
                const db = (0, client_js_1.getDb)();
                const [wf] = await db
                    .select()
                    .from(schema_js_1.workflows)
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.workflows.id, workflowId), (0, drizzle_orm_1.eq)(schema_js_1.workflows.tenantId, bot.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.workflows.botId, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.workflows.isEnabled, 1)))
                    .limit(1);
                if (!wf)
                    return;
                await (0, workflow_engine_js_1.executeWorkflow)({
                    workflowId: wf.id,
                    tenantId: bot.tenantId,
                    botId: bot.id,
                    triggerKind: 'COMMAND',
                    triggerRef: chatRef,
                    variables: { chatRef, text: userText, platformUserId: platformUserId ?? '' },
                }, { platform: bot.platform, token: (0, encryption_js_1.decryptSecret)(bot.tokenEncrypted), aiSystemPrompt: bot.aiSystemPrompt }, send);
                return;
            }
            default:
                return;
        }
    };
    const handleText = async (bot, text, chatRef, send, buttonId, platformUserId = null) => {
        const db = (0, client_js_1.getDb)();
        const trimmed = text.trim();
        const isButtonCallback = Boolean(buttonId);
        // 1) command match — never reinterpret the text of the original message
        // when the inbound event is a button callback.
        if (!isButtonCallback && trimmed.startsWith('/')) {
            let cmd = trimmed.toLowerCase().split(/\s+/)[0] ?? '';
            const at = cmd.indexOf('@');
            if (at > 0)
                cmd = cmd.slice(0, at);
            const [command] = await db
                .select()
                .from(schema_js_1.botCommands)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botCommands.botId, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.botCommands.command, cmd), (0, drizzle_orm_1.eq)(schema_js_1.botCommands.isEnabled, 1)))
                .limit(1);
            if (command) {
                await respond(bot, command.responseKind, command.responsePayload ?? null, trimmed, chatRef, send, platformUserId);
                return 'COMMAND';
            }
        }
        // 2) keyword match (EXACT / CONTAINS) — button callbacks must not
        // re-trigger keywords found in the old bot-authored message.
        const keywords = isButtonCallback ? [] : await db
            .select()
            .from(schema_js_1.botKeywords)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botKeywords.botId, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.botKeywords.isEnabled, 1)));
        const lower = trimmed.toLowerCase();
        const hit = keywords.find((k) => k.matchKind === 'EXACT'
            ? lower === k.keyword.trim().toLowerCase()
            : lower.includes(k.keyword.trim().toLowerCase()));
        if (hit) {
            await respond(bot, hit.responseKind, hit.responsePayload ?? null, trimmed, chatRef, send, platformUserId);
            return 'KEYWORD';
        }
        // 3) MESSAGE_RECEIVED workflows (bounded: at most 3 per message)
        const wfRows = await db
            .select()
            .from(schema_js_1.workflows)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.workflows.botId, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.workflows.tenantId, bot.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.workflows.isEnabled, 1)))
            .orderBy(schema_js_1.workflows.createdAt)
            .limit(3);
        const token = (0, encryption_js_1.decryptSecret)(bot.tokenEncrypted);
        let workflowMatched = false;
        for (const wf of wfRows) {
            const def = wf.definitionJson;
            if (!def || def.trigger?.kind !== 'MESSAGE_RECEIVED')
                continue;
            const kw = typeof def.trigger.keyword === 'string' ? def.trigger.keyword.trim().toLowerCase() : '';
            if (kw && !lower.includes(kw))
                continue;
            workflowMatched = true;
            await (0, workflow_engine_js_1.executeWorkflow)({
                workflowId: wf.id,
                tenantId: bot.tenantId,
                botId: bot.id,
                triggerKind: 'MESSAGE_RECEIVED',
                triggerRef: chatRef,
                variables: { chatRef, text: isButtonCallback ? '' : trimmed, platformUserId: platformUserId ?? '', ...(buttonId ? { buttonId } : {}) },
            }, { platform: bot.platform, token, aiSystemPrompt: bot.aiSystemPrompt }, send);
        }
        return workflowMatched ? 'WORKFLOW' : null;
    };
    const processor = async (job) => {
        const data = job.data;
        if (typeof data.eventId !== 'string')
            return;
        const db = (0, client_js_1.getDb)();
        // Claim atomically so duplicate BullMQ jobs / duplicate worker instances
        // cannot both send an external reply for the same bot event.
        const claimed = await db
            .update(schema_js_1.botEvents)
            .set({ state: 'PROCESSING' })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botEvents.id, data.eventId), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.state, 'PENDING')));
        const affected = Array.isArray(claimed)
            ? Number(claimed[0]?.affectedRows ?? 0)
            : Number(claimed?.affectedRows ?? 0);
        if (affected === 0)
            return;
        const [event] = await db.select().from(schema_js_1.botEvents).where((0, drizzle_orm_1.eq)(schema_js_1.botEvents.id, data.eventId)).limit(1);
        if (!event)
            return;
        const [bot] = await db
            .select()
            .from(schema_js_1.bots)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, event.botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, event.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, event.platform)))
            .limit(1);
        try {
            if (!bot || bot.status !== 'ACTIVE') {
                await db
                    .update(schema_js_1.botEvents)
                    .set({ state: 'PROCESSED', processedAt: new Date() })
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botEvents.id, event.id), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.tenantId, event.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.botId, event.botId), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.platform, event.platform), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.state, 'PROCESSING')));
                return;
            }
            const msg = (0, bot_message_js_1.extractBotMessage)(event.payloadJson);
            if (!msg || !msg.chatId) {
                await db
                    .update(schema_js_1.botEvents)
                    .set({ state: 'PROCESSED', processedAt: new Date() })
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botEvents.id, event.id), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.tenantId, event.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.botId, event.botId), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.platform, event.platform), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.state, 'PROCESSING')));
                return;
            }
            (0, bot_routing_js_1.assertBotEventScope)({
                tenantId: event.tenantId,
                botId: event.botId,
                platform: event.platform,
                chatRef: event.chatRef,
                platformUserId: event.senderRef,
            }, {
                tenantId: bot.tenantId,
                botId: bot.id,
                platform: bot.platform,
                chatRef: msg.chatId,
                platformUserId: msg.senderId,
            });
            await (0, events_js_1.emitEvent)({
                name: 'bot.message.received',
                tenantId: bot.tenantId,
                subjectType: 'bot',
                subjectId: bot.id,
                props: { botId: bot.id, platform: bot.platform },
            });
            // upsert bot_users (first/last seen)
            if (msg.senderId) {
                const now = new Date();
                await db
                    .insert(schema_js_1.botUsers)
                    .values({
                    id: (0, ids_js_1.newId)(),
                    botId: bot.id,
                    platformUserId: msg.senderId,
                    username: msg.username,
                    displayName: msg.displayName,
                    firstSeenAt: now,
                    lastSeenAt: now,
                })
                    .onDuplicateKeyUpdate({
                    set: {
                        lastSeenAt: now,
                        ...(msg.username ? { username: msg.username } : {}),
                        ...(msg.displayName ? { displayName: msg.displayName } : {}),
                    },
                });
            }
            const conversationId = await ensureConversation(bot, msg.chatId, msg.senderId);
            const inboundMessageId = (0, ids_js_1.newId)();
            await db.insert(schema_js_1.botMessages).values({
                id: inboundMessageId, tenantId: bot.tenantId, botId: bot.id, conversationId, platform: bot.platform, direction: 'INBOUND',
                platformMessageId: event.externalId, senderRef: msg.senderId, text: msg.text.slice(0, 4000), status: 'RECEIVED',
            });
            const send = makeSend(bot, (0, encryption_js_1.decryptSecret)(bot.tokenEncrypted), msg.chatId, msg.senderId);
            const actionType = await handleText(bot, msg.text, msg.chatId, send, msg.buttonId, msg.senderId);
            const recordedActionType = msg.buttonId ? 'BUTTON' : actionType;
            const recordedActionRef = msg.buttonId ?? (actionType === 'COMMAND' ? msg.text.trim().split(/\s+/)[0] : null);
            if (recordedActionType) {
                await db.update(schema_js_1.botMessages).set({ actionType: recordedActionType, actionRef: recordedActionRef }).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botMessages.id, inboundMessageId), (0, drizzle_orm_1.eq)(schema_js_1.botMessages.tenantId, event.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.botMessages.botId, event.botId)));
            }
            if (msg.buttonId) {
                await (0, events_js_1.emitEvent)({
                    name: 'bot.button.clicked',
                    tenantId: bot.tenantId,
                    subjectType: 'bot',
                    subjectId: bot.id,
                    props: { botId: bot.id, platform: bot.platform, buttonId: msg.buttonId },
                    analyticsDedupeKey: `bot-button:${event.id}`,
                });
            }
            await db
                .update(schema_js_1.botEvents)
                .set({ state: 'PROCESSED', processedAt: new Date() })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botEvents.id, event.id), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.tenantId, event.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.botId, event.botId), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.platform, event.platform), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.state, 'PROCESSING')));
        }
        catch (err) {
            log.error({ eventId: event.id, err: err instanceof Error ? err.message : 'bot_event_error' }, 'bot_event_failed');
            await db
                .update(schema_js_1.botEvents)
                .set({ state: 'FAILED', processedAt: new Date() })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botEvents.id, event.id), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.tenantId, event.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.botId, event.botId), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.platform, event.platform), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.state, 'PROCESSING')))
                .catch(() => undefined);
            if (shouldNotify(bot?.id ?? event.id)) {
                await (0, delivery_js_1.notifyTenant)({
                    tenantId: event.tenantId,
                    kind: 'BOT_EVENT_FAILED',
                    titleFa: 'خطا در پردازش پیام ربات',
                    bodyFa: `ربات «${bot?.title ?? ''}» در پردازش یکی از پیام‌ها خطا داشت. تنظیمات ربات را بررسی کنید.`,
                }).catch(() => undefined);
            }
        }
    };
    return (0, connection_js_1.createWorker)('bot-events', processor, { concurrency: (0, env_js_1.loadEnv)().BOT_EVENT_CONCURRENCY });
}
