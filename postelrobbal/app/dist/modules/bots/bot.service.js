"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapProviderError = mapProviderError;
exports.getOwnedBot = getOwnedBot;
exports.listBots = listBots;
exports.connectBot = connectBot;
exports.verifyBot = verifyBot;
exports.enableBot = enableBot;
exports.disableBot = disableBot;
exports.setBotMode = setBotMode;
exports.updateAiSettings = updateAiSettings;
exports.getBotToken = getBotToken;
exports.listBotUsers = listBotUsers;
exports.exportBotUsers = exportBotUsers;
exports.listBotConversations = listBotConversations;
exports.listBotConversationMessages = listBotConversationMessages;
exports.getBotStats = getBotStats;
exports.normalizeCommandName = normalizeCommandName;
exports.listBotCommands = listBotCommands;
exports.createBotCommand = createBotCommand;
exports.updateBotCommand = updateBotCommand;
exports.deleteBotCommand = deleteBotCommand;
exports.listBotKeywords = listBotKeywords;
exports.createBotKeyword = createBotKeyword;
exports.updateBotKeyword = updateBotKeyword;
exports.deleteBotKeyword = deleteBotKeyword;
exports.getBotCapabilities = getBotCapabilities;
exports.ingestBotWebhook = ingestBotWebhook;
exports.ingestBotPollingUpdate = ingestBotPollingUpdate;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const errors_js_1 = require("../../core/errors.js");
const events_js_1 = require("../../core/events.js");
const audit_js_1 = require("../../core/audit.js");
const encryption_js_1 = require("../../security/encryption.js");
const index_js_1 = require("../../providers/index.js");
const env_js_1 = require("../../config/env.js");
const connection_js_1 = require("../../queue/connection.js");
const queues_js_1 = require("../../queue/queues.js");
const plan_service_js_1 = require("../subscriptions/plan.service.js");
const logger_js_1 = require("../../core/logger.js");
const bot_message_js_1 = require("../../core/bot-message.js");
const channel_service_js_1 = require("../channels/channel.service.js");
const bot_users_export_js_1 = require("./bot-users-export.js");
const botLog = (0, logger_js_1.createLogger)('bot-service');
function asId(v) {
    if (typeof v === 'number' && Number.isFinite(v))
        return String(v);
    if (typeof v === 'string' && v.length > 0 && v.length <= 190)
        return v;
    return null;
}
function toPublicHealth(row) {
    const raw = row.healthJson;
    if (!raw || typeof raw !== 'object')
        return null;
    const src = raw;
    // Never expose webhook URLs because Bale/Rubika may keep their secret in
    // the query string. Provider identity is intentionally non-secret and is
    // useful for operational diagnostics.
    const allowed = [
        'ok', 'verify', 'providerBotId', 'verifiedAt', 'connectionMode', 'lastEnable',
        'checkedAt', 'errorCode', 'verifyError', 'errorClass', 'errorMessageFa', 'failedAt', 'webhook',
    ];
    return Object.fromEntries(allowed.filter((key) => src[key] !== undefined).map((key) => [key, src[key]]));
}
function toPublicBot(row) {
    return {
        id: row.id,
        platform: row.platform,
        title: row.title,
        username: row.username,
        status: row.status,
        mode: row.mode,
        tokenMasked: row.tokenMasked,
        aiEnabled: row.aiEnabled === 1,
        aiSystemPrompt: row.aiSystemPrompt,
        lastEventAt: row.lastEventAt,
        healthJson: toPublicHealth(row),
        createdAt: row.createdAt,
    };
}
/** Map a classified ProviderError to the Persian-safe AppError contract (§114). */
function mapProviderError(err) {
    if (err instanceof errors_js_1.AppError)
        return err;
    const cls = err.providerClass;
    if (typeof cls !== 'string')
        return new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
    const rawMsg = err.userMessageFa;
    const fa = typeof rawMsg === 'string' ? rawMsg : undefined;
    switch (cls) {
        case 'UNAUTHORIZED':
            return new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAUTHORIZED());
        case 'RATE_LIMITED':
            return new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_RATE_LIMITED());
        case 'TRANSIENT':
            return new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
        case 'NOT_FOUND':
            return new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(fa ?? 'ربات یا مقصد در پلتفرم یافت نشد.'));
        case 'BLOCKED':
            return new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(fa ?? 'دسترسی ربات به مقصد مسدود است.'));
        case 'VALIDATION':
            return new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(fa));
        default:
            return new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
    }
}
async function getOwnedBot(tenantId, botId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select()
        .from(schema_js_1.bots)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId)))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('ربات'));
    return row;
}
// ---------- listing / connection ----------
async function listBots(tenantId) {
    const db = (0, client_js_1.getDb)();
    const rows = await db.select().from(schema_js_1.bots).where((0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId)).orderBy((0, drizzle_orm_1.desc)(schema_js_1.bots.createdAt));
    return rows.map(toPublicBot); // never exposes tokenEncrypted/webhookSecret (§93)
}
async function withProviderIdentityLock(platform, providerId, fn) {
    const redis = (0, connection_js_1.getRedis)();
    const key = `postyar:bot-identity:${platform}:${providerId}`;
    const lockValue = `${process.pid}:${(0, ids_js_1.newToken)(12)}`;
    const acquired = await redis.set(key, lockValue, 'EX', 60, 'NX');
    if (acquired !== 'OK')
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('همین ربات هم‌زمان در حال اتصال یا بررسی است. دوباره تلاش کنید.'));
    try {
        return await fn();
    }
    finally {
        await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, key, lockValue).catch(() => undefined);
    }
}
async function assertProviderIdentityFree(platform, providerId, username, excludeBotId) {
    const rows = await (0, client_js_1.getDb)()
        .select({ id: schema_js_1.bots.id, username: schema_js_1.bots.username, healthJson: schema_js_1.bots.healthJson })
        .from(schema_js_1.bots)
        .where((0, drizzle_orm_1.eq)(schema_js_1.bots.platform, platform));
    for (const row of rows) {
        if (excludeBotId && row.id === excludeBotId)
            continue;
        const health = (row.healthJson ?? {});
        if (health['providerBotId'] === providerId || (username && row.username === username)) {
            throw new errors_js_1.AppError(errors_js_1.ERR.DUPLICATE('این ربات'));
        }
    }
}
function buildBotWebhookUrl(botId, webhookSecret, platform) {
    const base = (0, env_js_1.loadEnv)().API_URL.trim().replace(/\/+$/, '');
    if (!/^https:\/\//i.test(base)) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای وبهوک روبیکا، آدرس API باید عمومی و با HTTPS باشد.'));
    }
    return platform === 'telegram'
        ? `${base}/api/v1/webhooks/bots/${botId}`
        : `${base}/api/v1/webhooks/bots/${botId}?s=${encodeURIComponent(webhookSecret)}`;
}
async function connectBot(tenantId, input) {
    const token = input.token.trim();
    if (!token)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('توکن ربات نمی‌تواند خالی باشد.'));
    const provider = (0, index_js_1.getProvider)(input.platform);
    const identity = await provider.verifyBot(token).catch((err) => {
        throw mapProviderError(err);
    });
    if (!identity.id.trim())
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('شناسهٔ ربات از پلتفرم دریافت نشد.'));
    return withProviderIdentityLock(input.platform, identity.id, async () => {
        await assertProviderIdentityFree(input.platform, identity.id, identity.username);
        const db = (0, client_js_1.getDb)();
        const id = (0, ids_js_1.newId)();
        const now = new Date();
        const mode = input.platform === 'rubika' ? 'WEBHOOK' : 'POLLING';
        const webhookSecret = provider.capabilities().webhook ? (0, ids_js_1.newToken)(24) : null;
        const storedWebhookSecret = webhookSecret ? await (0, ids_js_1.sha256Hex)(webhookSecret) : null;
        if (mode === 'POLLING' && provider.capabilities().webhook && typeof provider.deleteWebhook === 'function') {
            await provider.deleteWebhook(token).catch((err) => { throw mapProviderError(err); });
        }
        await db.transaction(async (tx) => {
            // Serialize bot creation per tenant so max_bots cannot be exceeded by
            // concurrent connect requests that all pass an earlier count check.
            await tx.select({ id: schema_js_1.users.id }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, tenantId)).limit(1).for('update');
            await (0, plan_service_js_1.assertWithinLimit)(tenantId, 'bots');
            await tx.insert(schema_js_1.bots).values({
                id, tenantId, platform: input.platform, tokenEncrypted: (0, encryption_js_1.encryptSecret)(token), tokenMasked: (0, encryption_js_1.maskSecret)(token),
                username: identity.username, title: (input.title?.trim() || identity.title || 'ربات').slice(0, 190), status: 'ACTIVE', mode,
                webhookSecret: storedWebhookSecret, healthJson: { verify: 'ok', providerBotId: identity.id, verifiedAt: now.toISOString(), connectionMode: mode },
            });
        });
        const created = await getOwnedBot(tenantId, id);
        if (mode === 'WEBHOOK' && provider.capabilities().webhook && typeof provider.setWebhook === 'function' && webhookSecret) {
            const url = buildBotWebhookUrl(id, webhookSecret, input.platform);
            try {
                await provider.setWebhook(token, url, webhookSecret);
                // The provider needs the one-time raw secret to configure ingress, but
                // the database stores neither that secret nor the query-bearing URL.
                await db.update(schema_js_1.bots).set({ webhookUrl: url.split('?')[0].slice(0, 255), webhookRegisteredAt: now }).where((0, drizzle_orm_1.eq)(schema_js_1.bots.id, id));
            }
            catch (err) {
                const mapped = mapProviderError(err);
                await db.update(schema_js_1.bots).set({
                    status: 'ERROR',
                    healthJson: { verify: 'ok', webhook: 'failed', webhookUrl: url.split('?')[0], errorClass: mapped instanceof Error && 'providerClass' in mapped ? String(mapped.providerClass ?? '') : 'UNKNOWN', errorMessageFa: mapped instanceof Error ? mapped.message : 'خطای اتصال وبهوک روبیکا', failedAt: new Date().toISOString() },
                }).where((0, drizzle_orm_1.eq)(schema_js_1.bots.id, id)).catch(() => undefined);
                throw mapped;
            }
        }
        await (0, events_js_1.emitEvent)({
            name: 'bot.created',
            tenantId,
            subjectType: 'bot',
            subjectId: id,
            props: { platform: input.platform },
        });
        await (0, audit_js_1.audit)({ action: 'bot.connect', actorId: tenantId, subjectType: 'bot', subjectId: id, meta: { platform: input.platform } });
        return toPublicBot(created);
    });
}
async function verifyBot(tenantId, botId) {
    const bot = await getOwnedBot(tenantId, botId);
    const provider = (0, index_js_1.getProvider)(bot.platform);
    const identity = await provider.verifyBot((0, encryption_js_1.decryptSecret)(bot.tokenEncrypted)).catch((err) => {
        throw mapProviderError(err);
    });
    if (!identity.id.trim())
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('شناسهٔ ربات از پلتفرم دریافت نشد.'));
    await withProviderIdentityLock(bot.platform, identity.id, async () => {
        await assertProviderIdentityFree(bot.platform, identity.id, identity.username, bot.id);
        const db = (0, client_js_1.getDb)();
        await db
            .update(schema_js_1.bots)
            .set({
            username: identity.username,
            healthJson: { ...(bot.healthJson ?? {}), verify: 'ok', providerBotId: identity.id, verifiedAt: new Date().toISOString() },
        })
            .where((0, drizzle_orm_1.eq)(schema_js_1.bots.id, bot.id));
    });
    await (0, audit_js_1.audit)({ action: 'bot.verify', actorId: tenantId, subjectType: 'bot', subjectId: bot.id });
    return { username: identity.username, title: identity.title };
}
async function enableBot(tenantId, botId) {
    const db = (0, client_js_1.getDb)();
    let enabled = false;
    await db.transaction(async (tx) => {
        const [bot] = await tx
            .select()
            .from(schema_js_1.bots)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId)))
            .limit(1)
            .for('update');
        if (!bot)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('ربات'));
        if (bot.status === 'ACTIVE')
            return;
        const provider = (0, index_js_1.getProvider)(bot.platform);
        const token = (0, encryption_js_1.decryptSecret)(bot.tokenEncrypted);
        let storedWebhookSecret = bot.webhookSecret && !/^[0-9a-f]{64}$/i.test(bot.webhookSecret)
            ? await (0, ids_js_1.sha256Hex)(bot.webhookSecret)
            : bot.webhookSecret;
        let webhookUrl = bot.webhookUrl;
        let webhookRegisteredAt = bot.webhookRegisteredAt;
        if (bot.mode === 'WEBHOOK' && provider.capabilities().webhook && typeof provider.setWebhook === 'function') {
            // Stored values are hashes. Rotate on enable so the clear secret exists
            // only in this call and in the provider's webhook configuration.
            const providerSecret = (0, ids_js_1.newToken)(24);
            storedWebhookSecret = await (0, ids_js_1.sha256Hex)(providerSecret);
            const url = buildBotWebhookUrl(bot.id, providerSecret, bot.platform);
            await provider.setWebhook(token, url, providerSecret).catch((err) => {
                throw mapProviderError(err);
            });
            webhookUrl = url.split('?')[0].slice(0, 255);
            webhookRegisteredAt = new Date();
        }
        else if (bot.mode === 'POLLING') {
            if (provider.capabilities().webhook && typeof provider.deleteWebhook === 'function') {
                await provider.deleteWebhook(token).catch((err) => { throw mapProviderError(err); });
            }
            webhookUrl = null;
            webhookRegisteredAt = null;
        }
        await tx
            .update(schema_js_1.bots)
            .set({
            status: 'ACTIVE',
            webhookSecret: storedWebhookSecret,
            webhookUrl,
            webhookRegisteredAt,
            healthJson: { ...(bot.healthJson ?? {}), lastEnable: new Date().toISOString() },
        })
            .where((0, drizzle_orm_1.eq)(schema_js_1.bots.id, bot.id));
        enabled = true;
    });
    if (enabled) {
        await (0, events_js_1.emitEvent)({ name: 'bot.enabled', tenantId, subjectType: 'bot', subjectId: botId });
        await (0, audit_js_1.audit)({ action: 'bot.enable', actorId: tenantId, subjectType: 'bot', subjectId: botId });
    }
    return toPublicBot(await getOwnedBot(tenantId, botId));
}
async function disableBot(tenantId, botId) {
    const db = (0, client_js_1.getDb)();
    let disabled = false;
    const now = new Date();
    await db.transaction(async (tx) => {
        const [bot] = await tx
            .select()
            .from(schema_js_1.bots)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId)))
            .limit(1)
            .for('update');
        if (!bot)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('ربات'));
        if (bot.status === 'DISABLED')
            return;
        const provider = (0, index_js_1.getProvider)(bot.platform);
        if (bot.platform !== 'rubika' && provider.capabilities().webhook && typeof provider.deleteWebhook === 'function') {
            await provider.deleteWebhook((0, encryption_js_1.decryptSecret)(bot.tokenEncrypted)).catch((err) => {
                // Disabling ingress is still enforced in Postyar even if provider-side
                // webhook deletion is temporarily unavailable. Record the incident and
                // continue with the durable application-side DISABLED state.
                logProviderDisableFailure(bot.id, err);
            });
        }
        await tx.update(schema_js_1.bots).set({ status: 'DISABLED' }).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE')));
        await tx
            .update(schema_js_1.channels)
            .set({
            status: 'PENDING_VERIFY',
            lastVerifiedAt: null,
            healthJson: { ok: false, errorCode: 'BOT_DISABLED', checkedAt: now.toISOString() },
            updatedAt: now,
        })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.botId, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE')));
        disabled = true;
    });
    if (disabled) {
        await (0, events_js_1.emitEvent)({ name: 'bot.disabled', tenantId, subjectType: 'bot', subjectId: botId });
        await (0, audit_js_1.audit)({ action: 'bot.disable', actorId: tenantId, subjectType: 'bot', subjectId: botId });
    }
    return toPublicBot(await getOwnedBot(tenantId, botId));
}
function logProviderDisableFailure(botId, err) {
    botLog.warn({ botId, error: err instanceof Error ? err.message : String(err ?? '') }, 'bot_webhook_delete_on_disable_failed');
}
async function setBotMode(tenantId, botId, mode) {
    const db = (0, client_js_1.getDb)();
    let changed = false;
    await db.transaction(async (tx) => {
        const [bot] = await tx
            .select()
            .from(schema_js_1.bots)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId)))
            .limit(1)
            .for('update');
        if (!bot)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('ربات'));
        if (mode === bot.mode)
            return;
        if (bot.platform === 'rubika' && mode === 'POLLING') {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای روبیکا حالت وبهوک رسمی فعال است؛ برای جلوگیری از دو دریافت هم‌زمان، حالت پایش دوره‌ای از پنل قابل انتخاب نیست.'));
        }
        const provider = (0, index_js_1.getProvider)(bot.platform);
        let storedWebhookSecret = bot.webhookSecret && !/^[0-9a-f]{64}$/i.test(bot.webhookSecret)
            ? await (0, ids_js_1.sha256Hex)(bot.webhookSecret)
            : bot.webhookSecret;
        let webhookUrl = bot.webhookUrl;
        let webhookRegisteredAt = bot.webhookRegisteredAt;
        if (mode === 'WEBHOOK') {
            if (!provider.capabilities().webhook || typeof provider.setWebhook !== 'function') {
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('این پلتفرم از حالت وبهوک پشتیبانی نمی‌کند.'));
            }
            // A hash cannot be sent back to the provider as its webhook secret.
            // Always rotate when switching into webhook mode, then persist the hash.
            const providerSecret = (0, ids_js_1.newToken)(24);
            storedWebhookSecret = await (0, ids_js_1.sha256Hex)(providerSecret);
            if (bot.status === 'ACTIVE') {
                const url = buildBotWebhookUrl(bot.id, providerSecret, bot.platform);
                await provider.setWebhook((0, encryption_js_1.decryptSecret)(bot.tokenEncrypted), url, providerSecret).catch((err) => {
                    throw mapProviderError(err);
                });
                webhookUrl = url.split('?')[0].slice(0, 255);
                webhookRegisteredAt = new Date();
            }
            else {
                webhookUrl = null;
                webhookRegisteredAt = null;
            }
        }
        else {
            if (provider.capabilities().webhook && typeof provider.deleteWebhook === 'function') {
                await provider.deleteWebhook((0, encryption_js_1.decryptSecret)(bot.tokenEncrypted)).catch((err) => { throw mapProviderError(err); });
            }
            webhookUrl = null;
            webhookRegisteredAt = null;
        }
        await tx
            .update(schema_js_1.bots)
            .set({ mode, webhookSecret: storedWebhookSecret, webhookUrl, webhookRegisteredAt })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.bots.mode, bot.mode)));
        changed = true;
    });
    if (changed) {
        await (0, audit_js_1.audit)({ action: 'bot.mode', actorId: tenantId, subjectType: 'bot', subjectId: botId, meta: { mode } });
    }
    return toPublicBot(await getOwnedBot(tenantId, botId));
}
async function updateAiSettings(tenantId, botId, input) {
    const bot = await getOwnedBot(tenantId, botId);
    const db = (0, client_js_1.getDb)();
    await db
        .update(schema_js_1.bots)
        .set({
        aiEnabled: input.aiEnabled ? 1 : 0,
        aiSystemPrompt: input.aiSystemPrompt === undefined ? bot.aiSystemPrompt : input.aiSystemPrompt,
    })
        .where((0, drizzle_orm_1.eq)(schema_js_1.bots.id, bot.id));
    await (0, audit_js_1.audit)({
        action: 'bot.ai_settings',
        actorId: tenantId,
        subjectType: 'bot',
        subjectId: bot.id,
        meta: { aiEnabled: input.aiEnabled },
    });
    return toPublicBot(await getOwnedBot(tenantId, botId));
}
/** Internal use only (worker/delivery) — never exposed through HTTP. */
async function getBotToken(tenantId, botId) {
    const bot = await getOwnedBot(tenantId, botId);
    return (0, encryption_js_1.decryptSecret)(bot.tokenEncrypted);
}
// ---------- users / stats ----------
async function listBotUsers(tenantId, botId, page, pageSize) {
    await getOwnedBot(tenantId, botId);
    const db = (0, client_js_1.getDb)();
    const offset = (page - 1) * pageSize;
    const items = await db
        .select({
        id: schema_js_1.botUsers.id,
        platformUserId: schema_js_1.botUsers.platformUserId,
        username: schema_js_1.botUsers.username,
        displayName: schema_js_1.botUsers.displayName,
        firstSeenAt: schema_js_1.botUsers.firstSeenAt,
        lastSeenAt: schema_js_1.botUsers.lastSeenAt,
    })
        .from(schema_js_1.botUsers)
        .where((0, drizzle_orm_1.eq)(schema_js_1.botUsers.botId, botId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.botUsers.lastSeenAt))
        .limit(pageSize)
        .offset(offset);
    const [countRow] = await db
        .select({ count: (0, drizzle_orm_1.sql) `count(*)` })
        .from(schema_js_1.botUsers)
        .where((0, drizzle_orm_1.eq)(schema_js_1.botUsers.botId, botId));
    return { items, total: Number(countRow?.count ?? 0), page, pageSize };
}
/** Tenant-scoped, bounded CSV export. The extra row detects cap overflow without COUNT+SELECT races. */
async function exportBotUsers(tenantId, botId) {
    await getOwnedBot(tenantId, botId);
    const rows = await (0, client_js_1.getDb)()
        .select({
        displayName: schema_js_1.botUsers.displayName,
        platformUserId: schema_js_1.botUsers.platformUserId,
        username: schema_js_1.botUsers.username,
        firstSeenAt: schema_js_1.botUsers.firstSeenAt,
        lastSeenAt: schema_js_1.botUsers.lastSeenAt,
    })
        .from(schema_js_1.botUsers)
        .where((0, drizzle_orm_1.eq)(schema_js_1.botUsers.botId, botId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.botUsers.lastSeenAt))
        .limit(bot_users_export_js_1.MAX_BOT_USER_EXPORT + 1);
    if (rows.length > bot_users_export_js_1.MAX_BOT_USER_EXPORT) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای جلوگیری از تولید فایل بسیار بزرگ، خروجی هر بار به ۱۰٬۰۰۰ کاربر محدود است.'));
    }
    await (0, audit_js_1.audit)({
        action: 'bot.users.export',
        actorId: tenantId,
        subjectType: 'bot',
        subjectId: botId,
        meta: { rowCount: rows.length, format: 'csv' },
    });
    return rows;
}
async function listBotConversations(tenantId, botId, page, pageSize, platformUserId) {
    await getOwnedBot(tenantId, botId);
    const db = (0, client_js_1.getDb)();
    const where = platformUserId === undefined
        ? (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botConversations.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.botConversations.botId, botId))
        : (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botConversations.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.botConversations.botId, botId), (0, drizzle_orm_1.eq)(schema_js_1.botConversations.platformUserId, platformUserId));
    const offset = (page - 1) * pageSize;
    const rows = await db
        .select({
        id: schema_js_1.botConversations.id,
        platform: schema_js_1.botConversations.platform,
        chatRef: schema_js_1.botConversations.chatRef,
        platformUserId: schema_js_1.botConversations.platformUserId,
        username: schema_js_1.botUsers.username,
        displayName: schema_js_1.botUsers.displayName,
        lastActivityAt: schema_js_1.botConversations.lastActivityAt,
    })
        .from(schema_js_1.botConversations)
        .leftJoin(schema_js_1.botUsers, (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botUsers.botId, botId), (0, drizzle_orm_1.eq)(schema_js_1.botUsers.platformUserId, schema_js_1.botConversations.platformUserId)))
        .where(where)
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.botConversations.lastActivityAt))
        .limit(pageSize)
        .offset(offset);
    const [countRow] = await db
        .select({ count: (0, drizzle_orm_1.sql) `count(*)` })
        .from(schema_js_1.botConversations)
        .where(where);
    return { items: rows, total: Number(countRow?.count ?? 0), page, pageSize };
}
async function listBotConversationMessages(tenantId, botId, conversationId, page, pageSize) {
    await getOwnedBot(tenantId, botId);
    const db = (0, client_js_1.getDb)();
    const [conversation] = await db
        .select({ id: schema_js_1.botConversations.id })
        .from(schema_js_1.botConversations)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botConversations.id, conversationId), (0, drizzle_orm_1.eq)(schema_js_1.botConversations.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.botConversations.botId, botId)))
        .limit(1);
    if (!conversation)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('گفتگو'));
    const offset = (page - 1) * pageSize;
    const items = await db
        .select({
        id: schema_js_1.botMessages.id,
        direction: schema_js_1.botMessages.direction,
        platformMessageId: schema_js_1.botMessages.platformMessageId,
        senderRef: schema_js_1.botMessages.senderRef,
        text: schema_js_1.botMessages.text,
        actionType: schema_js_1.botMessages.actionType,
        actionRef: schema_js_1.botMessages.actionRef,
        status: schema_js_1.botMessages.status,
        createdAt: schema_js_1.botMessages.createdAt,
    })
        .from(schema_js_1.botMessages)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botMessages.conversationId, conversationId), (0, drizzle_orm_1.eq)(schema_js_1.botMessages.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.botMessages.botId, botId)))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.botMessages.createdAt))
        .limit(pageSize)
        .offset(offset);
    const [countRow] = await db
        .select({ count: (0, drizzle_orm_1.sql) `count(*)` })
        .from(schema_js_1.botMessages)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botMessages.conversationId, conversationId), (0, drizzle_orm_1.eq)(schema_js_1.botMessages.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.botMessages.botId, botId)));
    return { items, total: Number(countRow?.count ?? 0), page, pageSize };
}
async function getBotStats(tenantId, botId) {
    const bot = await getOwnedBot(tenantId, botId);
    const db = (0, client_js_1.getDb)();
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const kindRows = await db
        .select({ kind: schema_js_1.botEvents.kind, count: (0, drizzle_orm_1.sql) `count(*)` })
        .from(schema_js_1.botEvents)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botEvents.botId, bot.id), (0, drizzle_orm_1.gte)(schema_js_1.botEvents.createdAt, since)))
        .groupBy(schema_js_1.botEvents.kind);
    const [sentRow] = await db
        .select({ count: (0, drizzle_orm_1.sql) `count(*)` })
        .from(schema_js_1.events)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.events.name, 'bot.message.sent'), (0, drizzle_orm_1.eq)(schema_js_1.events.tenantId, tenantId), (0, drizzle_orm_1.gte)(schema_js_1.events.createdAt, since), (0, drizzle_orm_1.sql) `json_extract(${schema_js_1.events.propsJson}, '$.botId') = ${bot.id}`));
    const [userRow] = await db
        .select({ count: (0, drizzle_orm_1.sql) `count(*)` })
        .from(schema_js_1.botUsers)
        .where((0, drizzle_orm_1.eq)(schema_js_1.botUsers.botId, bot.id));
    const [receivedRow] = await db
        .select({ count: (0, drizzle_orm_1.sql) `count(*)` })
        .from(schema_js_1.botMessages)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botMessages.botId, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.botMessages.direction, 'INBOUND'), (0, drizzle_orm_1.gte)(schema_js_1.botMessages.createdAt, since)));
    const [commandRow] = await db
        .select({ count: (0, drizzle_orm_1.sql) `count(*)` })
        .from(schema_js_1.botMessages)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botMessages.botId, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.botMessages.actionType, 'COMMAND'), (0, drizzle_orm_1.gte)(schema_js_1.botMessages.createdAt, since)));
    const [workflowRow] = await db
        .select({ count: (0, drizzle_orm_1.sql) `count(*)` })
        .from(schema_js_1.botMessages)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botMessages.botId, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.botMessages.actionType, 'WORKFLOW'), (0, drizzle_orm_1.gte)(schema_js_1.botMessages.createdAt, since)));
    const recentActivity = await db
        .select({ id: schema_js_1.botMessages.id, direction: schema_js_1.botMessages.direction, platform: schema_js_1.botMessages.platform, text: schema_js_1.botMessages.text, actionType: schema_js_1.botMessages.actionType, status: schema_js_1.botMessages.status, senderRef: schema_js_1.botMessages.senderRef, createdAt: schema_js_1.botMessages.createdAt })
        .from(schema_js_1.botMessages)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botMessages.botId, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.botMessages.tenantId, tenantId)))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.botMessages.createdAt))
        .limit(50);
    return {
        eventsByKind: kindRows.map((r) => ({ kind: r.kind, count: Number(r.count ?? 0) })),
        messagesSent30d: Number(sentRow?.count ?? 0),
        messagesReceived30d: Number(receivedRow?.count ?? 0),
        commandsMatched30d: Number(commandRow?.count ?? 0),
        workflowsRun30d: Number(workflowRow?.count ?? 0),
        userCount: Number(userRow?.count ?? 0),
        recentActivity,
    };
}
// ---------- commands ----------
function normalizeCommandName(raw) {
    let cmd = raw.trim().toLowerCase().split(/\s+/)[0] ?? '';
    const at = cmd.indexOf('@');
    if (at > 0)
        cmd = cmd.slice(0, at);
    if (!cmd.startsWith('/'))
        cmd = `/${cmd}`;
    return cmd;
}
async function listBotCommands(tenantId, botId) {
    await getOwnedBot(tenantId, botId);
    return (0, client_js_1.getDb)()
        .select()
        .from(schema_js_1.botCommands)
        .where((0, drizzle_orm_1.eq)(schema_js_1.botCommands.botId, botId))
        .orderBy(schema_js_1.botCommands.createdAt);
}
async function createBotCommand(tenantId, botId, input) {
    await getOwnedBot(tenantId, botId);
    const command = normalizeCommandName(input.command);
    if (!/^\/[a-z0-9_]{1,31}$/.test(command)) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('دستور باید با «/» و حروف لاتین، عدد یا زیرخط باشد.'));
    }
    const db = (0, client_js_1.getDb)();
    const id = (0, ids_js_1.newId)();
    await db
        .insert(schema_js_1.botCommands)
        .values({
        id,
        botId,
        tenantId,
        command,
        descriptionFa: input.descriptionFa ?? '',
        responseKind: input.responseKind,
        responsePayload: input.responsePayload ?? null,
    })
        .catch((err) => {
        // ER_DUP_ENTRY (1062) → user-facing duplicate; anything else rethrown as-is.
        if (err?.errno === 1062)
            throw new errors_js_1.AppError(errors_js_1.ERR.DUPLICATE('این دستور'));
        throw err;
    });
    await (0, audit_js_1.audit)({ action: 'bot.command.create', actorId: tenantId, subjectType: 'bot_command', subjectId: id, meta: { command } });
    const [row] = await db.select().from(schema_js_1.botCommands).where((0, drizzle_orm_1.eq)(schema_js_1.botCommands.id, id)).limit(1);
    return row;
}
async function updateBotCommand(tenantId, commandId, patch, botId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select()
        .from(schema_js_1.botCommands)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botCommands.id, commandId), (0, drizzle_orm_1.eq)(schema_js_1.botCommands.tenantId, tenantId), ...(botId ? [(0, drizzle_orm_1.eq)(schema_js_1.botCommands.botId, botId)] : [])))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('دستور'));
    const command = patch.command !== undefined ? normalizeCommandName(patch.command) : undefined;
    if (command !== undefined && !/^\/[a-z0-9_]{1,31}$/.test(command)) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('دستور باید با «/» و حروف لاتین، عدد یا زیرخط باشد.'));
    }
    await db
        .update(schema_js_1.botCommands)
        .set({
        ...(command !== undefined ? { command } : {}),
        ...(patch.descriptionFa !== undefined ? { descriptionFa: patch.descriptionFa } : {}),
        ...(patch.responseKind !== undefined ? { responseKind: patch.responseKind } : {}),
        ...(patch.responsePayload !== undefined ? { responsePayload: patch.responsePayload } : {}),
        ...(patch.isEnabled !== undefined ? { isEnabled: patch.isEnabled ? 1 : 0 } : {}),
    })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botCommands.id, commandId), (0, drizzle_orm_1.eq)(schema_js_1.botCommands.tenantId, tenantId), ...(botId ? [(0, drizzle_orm_1.eq)(schema_js_1.botCommands.botId, botId)] : [])));
    await (0, audit_js_1.audit)({ action: 'bot.command.update', actorId: tenantId, subjectType: 'bot_command', subjectId: commandId });
    const [updated] = await db.select().from(schema_js_1.botCommands).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botCommands.id, commandId), (0, drizzle_orm_1.eq)(schema_js_1.botCommands.tenantId, tenantId), ...(botId ? [(0, drizzle_orm_1.eq)(schema_js_1.botCommands.botId, botId)] : []))).limit(1);
    return updated;
}
async function deleteBotCommand(tenantId, commandId, botId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({ id: schema_js_1.botCommands.id })
        .from(schema_js_1.botCommands)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botCommands.id, commandId), (0, drizzle_orm_1.eq)(schema_js_1.botCommands.tenantId, tenantId), ...(botId ? [(0, drizzle_orm_1.eq)(schema_js_1.botCommands.botId, botId)] : [])))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('دستور'));
    await db.delete(schema_js_1.botCommands).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botCommands.id, commandId), ...(botId ? [(0, drizzle_orm_1.eq)(schema_js_1.botCommands.botId, botId)] : [])));
    await (0, audit_js_1.audit)({ action: 'bot.command.delete', actorId: tenantId, subjectType: 'bot_command', subjectId: commandId });
}
// ---------- keywords ----------
async function listBotKeywords(tenantId, botId) {
    await getOwnedBot(tenantId, botId);
    return (0, client_js_1.getDb)()
        .select()
        .from(schema_js_1.botKeywords)
        .where((0, drizzle_orm_1.eq)(schema_js_1.botKeywords.botId, botId))
        .orderBy(schema_js_1.botKeywords.createdAt);
}
async function createBotKeyword(tenantId, botId, input) {
    await getOwnedBot(tenantId, botId);
    const keyword = input.keyword.trim();
    if (keyword.length < 2)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('کلمهٔ کلیدی باید حداقل ۲ نویسه باشد.'));
    const db = (0, client_js_1.getDb)();
    const id = (0, ids_js_1.newId)();
    await db.insert(schema_js_1.botKeywords).values({
        id,
        botId,
        tenantId,
        keyword: keyword.slice(0, 190),
        matchKind: input.matchKind,
        responseKind: input.responseKind,
        responsePayload: input.responsePayload ?? null,
    });
    await (0, audit_js_1.audit)({ action: 'bot.keyword.create', actorId: tenantId, subjectType: 'bot_keyword', subjectId: id });
    const [row] = await db.select().from(schema_js_1.botKeywords).where((0, drizzle_orm_1.eq)(schema_js_1.botKeywords.id, id)).limit(1);
    return row;
}
async function updateBotKeyword(tenantId, keywordId, patch, botId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select()
        .from(schema_js_1.botKeywords)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botKeywords.id, keywordId), (0, drizzle_orm_1.eq)(schema_js_1.botKeywords.tenantId, tenantId), ...(botId ? [(0, drizzle_orm_1.eq)(schema_js_1.botKeywords.botId, botId)] : [])))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کلمهٔ کلیدی'));
    if (patch.keyword !== undefined && patch.keyword.trim().length < 2) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('کلمهٔ کلیدی باید حداقل ۲ نویسه باشد.'));
    }
    await db
        .update(schema_js_1.botKeywords)
        .set({
        ...(patch.keyword !== undefined ? { keyword: patch.keyword.trim().slice(0, 190) } : {}),
        ...(patch.matchKind !== undefined ? { matchKind: patch.matchKind } : {}),
        ...(patch.responseKind !== undefined ? { responseKind: patch.responseKind } : {}),
        ...(patch.responsePayload !== undefined ? { responsePayload: patch.responsePayload } : {}),
        ...(patch.isEnabled !== undefined ? { isEnabled: patch.isEnabled ? 1 : 0 } : {}),
    })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botKeywords.id, keywordId), (0, drizzle_orm_1.eq)(schema_js_1.botKeywords.tenantId, tenantId), ...(botId ? [(0, drizzle_orm_1.eq)(schema_js_1.botKeywords.botId, botId)] : [])));
    await (0, audit_js_1.audit)({ action: 'bot.keyword.update', actorId: tenantId, subjectType: 'bot_keyword', subjectId: keywordId });
    const [updated] = await db.select().from(schema_js_1.botKeywords).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botKeywords.id, keywordId), (0, drizzle_orm_1.eq)(schema_js_1.botKeywords.tenantId, tenantId), ...(botId ? [(0, drizzle_orm_1.eq)(schema_js_1.botKeywords.botId, botId)] : []))).limit(1);
    return updated;
}
async function deleteBotKeyword(tenantId, keywordId, botId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({ id: schema_js_1.botKeywords.id })
        .from(schema_js_1.botKeywords)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botKeywords.id, keywordId), (0, drizzle_orm_1.eq)(schema_js_1.botKeywords.tenantId, tenantId), ...(botId ? [(0, drizzle_orm_1.eq)(schema_js_1.botKeywords.botId, botId)] : [])))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کلمهٔ کلیدی'));
    await db.delete(schema_js_1.botKeywords).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botKeywords.id, keywordId), ...(botId ? [(0, drizzle_orm_1.eq)(schema_js_1.botKeywords.botId, botId)] : [])));
    await (0, audit_js_1.audit)({ action: 'bot.keyword.delete', actorId: tenantId, subjectType: 'bot_keyword', subjectId: keywordId });
}
// ---------- provider capabilities ----------
async function getBotCapabilities(tenantId, botId) {
    const bot = await getOwnedBot(tenantId, botId);
    return (0, index_js_1.getProvider)(bot.platform).capabilities();
}
// ---------- public webhook ingestion (§187) ----------
async function ingestBotUpdate(bot, body) {
    let update = body;
    if (typeof update === 'string') {
        try {
            update = JSON.parse(update);
        }
        catch {
            return;
        }
    }
    if (!update || typeof update !== 'object' || Array.isArray(update))
        return;
    const updateId = update.update_id;
    const msg = (0, bot_message_js_1.extractBotMessage)(update);
    const externalId = asId(updateId) ?? msg?.buttonId ?? (update && typeof update === 'object' ? asId((update.message_id)) : null);
    const hashSeed = updateId !== undefined && updateId !== null ? updateId : { externalId, chatId: msg?.chatId, messageId: update && typeof update === 'object' ? update.message_id : null, body: update };
    const dedupHash = await (0, ids_js_1.sha256Hex)(bot.id + JSON.stringify(hashSeed));
    const eventId = (0, ids_js_1.newId)();
    const res = await (0, client_js_1.getDb)()
        .insert(schema_js_1.botEvents)
        .values({
        id: eventId,
        tenantId: bot.tenantId,
        botId: bot.id,
        platform: bot.platform,
        externalId,
        dedupHash,
        kind: msg ? 'message' : 'update',
        chatRef: msg?.chatId ?? null,
        senderRef: msg?.senderId ?? null,
        payloadJson: update,
    })
        .onDuplicateKeyUpdate({ set: { dedupHash: (0, drizzle_orm_1.sql) `${schema_js_1.botEvents.dedupHash}` } });
    const header = Array.isArray(res) ? res[0] : res;
    const affected = header?.affectedRows ?? 0;
    if (affected === 0) {
        // The event row may already exist while its first queue enqueue failed.
        // Re-dispatch only an existing PENDING event; PROCESSED/FAILED events are
        // intentionally left untouched to avoid duplicate processing.
        const [existing] = await (0, client_js_1.getDb)()
            .select({ id: schema_js_1.botEvents.id, state: schema_js_1.botEvents.state })
            .from(schema_js_1.botEvents)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.botEvents.botId, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.botEvents.dedupHash, dedupHash)))
            .limit(1);
        if (existing?.state === 'PENDING') {
            await (0, queues_js_1.enqueue)('bot-events', 'process', { eventId: existing.id }, { jobId: `botev:${existing.id}` });
        }
        return;
    }
    await (0, client_js_1.getDb)().update(schema_js_1.bots).set({ lastEventAt: new Date() }).where((0, drizzle_orm_1.eq)(schema_js_1.bots.id, bot.id));
    await (0, queues_js_1.enqueue)('bot-events', 'process', { eventId }, { jobId: `botev:${eventId}` });
}
async function ingestBotWebhook(botId, secretParam, body, secretHeader) {
    const db = (0, client_js_1.getDb)();
    const [bot] = await db
        .select({ id: schema_js_1.bots.id, tenantId: schema_js_1.bots.tenantId, platform: schema_js_1.bots.platform, mode: schema_js_1.bots.mode, status: schema_js_1.bots.status, webhookSecret: schema_js_1.bots.webhookSecret, tokenEncrypted: schema_js_1.bots.tokenEncrypted })
        .from(schema_js_1.bots)
        .where((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId))
        .limit(1);
    if (!bot || bot.status !== 'ACTIVE' || bot.mode !== 'WEBHOOK' || !bot.webhookSecret)
        return;
    const querySecret = typeof secretParam === 'string' ? secretParam : '';
    const headerSecret = typeof secretHeader === 'string' ? secretHeader : '';
    const secret = bot.platform === 'telegram' ? headerSecret : querySecret || headerSecret;
    if (!secret)
        return;
    // Backward-compatible hash-only verification. Existing rows may still have
    // a legacy plaintext secret until their first valid webhook arrives; after
    // successful proof, upgrade it in place using a compare-and-swap update.
    const storedSecret = bot.webhookSecret;
    const storedAsHash = /^[0-9a-f]{64}$/i.test(storedSecret);
    const expectedHash = storedAsHash ? storedSecret.toLowerCase() : await (0, ids_js_1.sha256Hex)(storedSecret);
    const suppliedHash = await (0, ids_js_1.sha256Hex)(secret);
    if (!(0, ids_js_1.timingSafeEqualStr)(suppliedHash, expectedHash))
        return;
    if (!storedAsHash) {
        await db.update(schema_js_1.bots)
            .set({ webhookSecret: expectedHash })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, bot.id), (0, drizzle_orm_1.eq)(schema_js_1.bots.webhookSecret, storedSecret)))
            .catch(() => undefined);
    }
    if (bot.platform === 'rubika') {
        const token = (0, encryption_js_1.decryptSecret)(bot.tokenEncrypted);
        if (await (0, channel_service_js_1.handleRubikaChannelDiscovery)(bot, body, token))
            return;
    }
    await ingestBotUpdate(bot, body);
}
/** Internal polling ingress. No secret is needed because updates come from the provider over the bot token. */
async function ingestBotPollingUpdate(botId, body) {
    const db = (0, client_js_1.getDb)();
    const [bot] = await db
        .select({ id: schema_js_1.bots.id, tenantId: schema_js_1.bots.tenantId, platform: schema_js_1.bots.platform, mode: schema_js_1.bots.mode, status: schema_js_1.bots.status, webhookSecret: schema_js_1.bots.webhookSecret })
        .from(schema_js_1.bots)
        .where((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId))
        .limit(1);
    if (!bot || bot.mode !== 'POLLING' || bot.status !== 'ACTIVE')
        return;
    await ingestBotUpdate(bot, body);
}
