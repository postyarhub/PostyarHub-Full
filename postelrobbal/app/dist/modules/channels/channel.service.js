"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeChannelRef = normalizeChannelRef;
exports.startRubikaChannelDiscovery = startRubikaChannelDiscovery;
exports.getRubikaChannelDiscovery = getRubikaChannelDiscovery;
exports.parseRubikaDiscoveryCommand = parseRubikaDiscoveryCommand;
exports.handleRubikaChannelDiscovery = handleRubikaChannelDiscovery;
exports.listChannels = listChannels;
exports.connectChannel = connectChannel;
exports.verifyChannel = verifyChannel;
exports.disconnectChannel = disconnectChannel;
exports.updateChannel = updateChannel;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const errors_js_1 = require("../../core/errors.js");
const events_js_1 = require("../../core/events.js");
const audit_js_1 = require("../../core/audit.js");
const plan_service_js_1 = require("../subscriptions/plan.service.js");
const index_js_1 = require("../../providers/index.js");
const encryption_js_1 = require("../../security/encryption.js");
const connection_js_1 = require("../../queue/connection.js");
const ids_js_2 = require("../../core/ids.js");
function normalizeChannelRef(platform, value) {
    const ref = value.trim();
    if (platform !== 'rubika')
        return ref;
    const webLink = ref.match(/^(?:https?:\/\/)?web\.rubika\.ir\/#c=([^&#\s]+)$/i);
    const fragmentRef = ref.match(/^#c=([^&#\s]+)$/i);
    const extracted = webLink?.[1] ?? fragmentRef?.[1] ?? null;
    if (extracted) {
        try {
            return decodeURIComponent(extracted).trim();
        }
        catch {
            return extracted.trim();
        }
    }
    if (ref.startsWith('@') || /^https?:\/\/(?:www\.)?rubika\.ir\//i.test(ref)) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای کانال روبیکا، لینک عمومی یا @نام‌کاربری قابل استفاده نیست. لینک مستقیم web.rubika.ir/#c=… یا خود chat_id را وارد کنید.'));
    }
    return ref;
}
const RUBIKA_DISCOVERY_TTL_SECONDS = 10 * 60;
const RUBIKA_DISCOVERY_PREFIX = 'postyar:rubika-channel-discovery:';
const RUBIKA_DISCOVERY_COMMAND_PREFIX = 'postyar:rubika-channel-discovery-command:';
const RUBIKA_DISCOVERY_LOCK_PREFIX = 'postyar:rubika-channel-discovery-lock:';
function discoveryKey(discoveryId) {
    return `${RUBIKA_DISCOVERY_PREFIX}${discoveryId}`;
}
function discoveryCommandKey(tenantId, botId, marker) {
    return `${RUBIKA_DISCOVERY_COMMAND_PREFIX}${tenantId}:${botId}:${marker}`;
}
function discoveryLockKey(discoveryId) {
    return `${RUBIKA_DISCOVERY_LOCK_PREFIX}${discoveryId}`;
}
function parseDiscovery(raw) {
    if (!raw)
        return null;
    try {
        const value = JSON.parse(raw);
        if (value.platform !== 'rubika' || typeof value.tenantId !== 'string' || typeof value.botId !== 'string' || typeof value.command !== 'string')
            return null;
        return value;
    }
    catch {
        return null;
    }
}
async function saveDiscovery(state) {
    const redis = (0, connection_js_1.getRedis)();
    const ttl = Math.max(1, Math.ceil((Date.parse(state.expiresAt) - Date.now()) / 1000));
    await redis.set(discoveryKey(state.discoveryId), JSON.stringify(state), 'EX', ttl);
}
function toDiscoveryStatus(state) {
    const expired = Date.parse(state.expiresAt) <= Date.now() && state.status !== 'COMPLETED';
    return {
        discoveryId: state.discoveryId,
        status: expired ? 'EXPIRED' : state.status,
        command: state.command,
        expiresAt: state.expiresAt,
        lastError: state.lastError,
        channelId: state.channelId,
        channelRef: state.channelRef,
        channelTitle: state.channelTitle,
    };
}
async function startRubikaChannelDiscovery(tenantId, input) {
    const db = (0, client_js_1.getDb)();
    const [bot] = await db.select({ id: schema_js_1.bots.id, status: schema_js_1.bots.status, platform: schema_js_1.bots.platform, mode: schema_js_1.bots.mode })
        .from(schema_js_1.bots)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, input.botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId)))
        .limit(1);
    if (!bot || bot.platform !== 'rubika' || bot.status !== 'ACTIVE' || bot.mode !== 'WEBHOOK') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای شناسایی کانال، یک ربات فعال روبیکا با وبهوک معتبر انتخاب کنید.'));
    }
    const marker = (0, ids_js_2.newToken)(9);
    const discoveryId = (0, ids_js_2.newToken)(18);
    const command = `/postyar-connect ${marker}`;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + RUBIKA_DISCOVERY_TTL_SECONDS * 1000);
    const state = {
        tenantId,
        botId: input.botId,
        platform: 'rubika',
        discoveryId,
        command,
        publicRef: input.publicRef?.trim() || null,
        title: input.title?.trim() || null,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        status: 'PENDING',
        lastError: null,
        channelId: null,
        channelRef: null,
        channelTitle: null,
    };
    const redis = (0, connection_js_1.getRedis)();
    const indexKey = discoveryCommandKey(tenantId, input.botId, marker);
    await redis.set(indexKey, discoveryId, 'EX', RUBIKA_DISCOVERY_TTL_SECONDS, 'NX');
    await saveDiscovery(state);
    return toDiscoveryStatus(state);
}
async function getRubikaChannelDiscovery(tenantId, discoveryId) {
    const state = parseDiscovery(await (0, connection_js_1.getRedis)().get(discoveryKey(discoveryId)));
    if (!state || state.tenantId !== tenantId)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('درخواست شناسایی'));
    return toDiscoveryStatus(state);
}
function parseRubikaDiscoveryCommand(text) {
    const match = text.trim().match(/^\/postyar-connect(?:@[^\s]+)?\s+([A-Za-z0-9_-]{6,40})$/i);
    return match?.[1] ?? null;
}
async function bindVerifiedRubikaChannel(tenantId, botId, chat, titleHint, publicRef) {
    const db = (0, client_js_1.getDb)();
    const channelRef = chat.id.trim();
    if (!channelRef)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('شناسهٔ کانال روبیکا از پلتفرم دریافت نشد.'));
    if (String(chat.type ?? '').toLowerCase() !== 'channel') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('پیام شناسایی از یک کانال روبیکا دریافت نشد. ربات را داخل همان کانال قرار دهید.'));
    }
    const now = new Date();
    const displayTitle = (chat.title?.trim() || titleHint?.trim() || publicRef?.trim() || chat.username?.trim() || 'کانال روبیکا').slice(0, 190);
    await db.transaction(async (tx) => {
        await tx.select({ id: schema_js_1.users.id }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, tenantId)).limit(1).for('update');
        const [existing] = await tx.select({ id: schema_js_1.channels.id, botId: schema_js_1.channels.botId, title: schema_js_1.channels.title })
            .from(schema_js_1.channels)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.platform, 'rubika'), (0, drizzle_orm_1.eq)(schema_js_1.channels.channelRef, channelRef)))
            .limit(1);
        if (!existing)
            await (0, plan_service_js_1.assertWithinLimit)(tenantId, 'channels');
        await tx.insert(schema_js_1.channelRegistry).values({ platform: 'rubika', channelRef, tenantId, claimedAt: now })
            .onDuplicateKeyUpdate({
            set: {
                tenantId: (0, drizzle_orm_1.sql) `IF(${schema_js_1.channelRegistry.tenantId} IS NULL OR ${schema_js_1.channelRegistry.tenantId} = ${tenantId}, ${tenantId}, ${schema_js_1.channelRegistry.tenantId})`,
                claimedAt: (0, drizzle_orm_1.sql) `IF(${schema_js_1.channelRegistry.tenantId} IS NULL OR ${schema_js_1.channelRegistry.tenantId} = ${tenantId}, ${now}, ${schema_js_1.channelRegistry.claimedAt})`,
                releasedAt: (0, drizzle_orm_1.sql) `IF(${schema_js_1.channelRegistry.tenantId} IS NULL OR ${schema_js_1.channelRegistry.tenantId} = ${tenantId}, NULL, ${schema_js_1.channelRegistry.releasedAt})`,
            },
        });
        const [claim] = await tx.select().from(schema_js_1.channelRegistry)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelRegistry.platform, 'rubika'), (0, drizzle_orm_1.eq)(schema_js_1.channelRegistry.channelRef, channelRef))).limit(1);
        if (claim && claim.tenantId && claim.tenantId !== tenantId) {
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('این کانال قبلاً توسط کاربر دیگری ثبت شده است.'));
        }
        if (existing) {
            await tx.update(schema_js_1.channels).set({ title: displayTitle, botId, status: 'ACTIVE', type: 'channel', healthJson: {
                    ok: true, verifiedVia: 'rubika_discovery', botId, destinationId: channelRef,
                    destinationType: chat.type, destinationTitle: chat.title, destinationUsername: chat.username,
                }, lastVerifiedAt: now, updatedAt: now }).where((0, drizzle_orm_1.eq)(schema_js_1.channels.id, existing.id));
        }
        else {
            await tx.insert(schema_js_1.channels).values({
                id: (0, ids_js_1.newId)(), tenantId, platform: 'rubika', channelRef, title: displayTitle, type: 'channel', mode: 'bot_post', status: 'ACTIVE', botId,
                healthJson: { ok: true, verifiedVia: 'rubika_discovery', botId, destinationId: channelRef,
                    destinationType: chat.type, destinationTitle: chat.title, destinationUsername: chat.username },
                lastVerifiedAt: now,
            });
        }
    });
    const [row] = await db.select().from(schema_js_1.channels)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.platform, 'rubika'), (0, drizzle_orm_1.eq)(schema_js_1.channels.channelRef, channelRef))).limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    await (0, events_js_1.emitEvent)({ name: 'channel.created', tenantId, subjectType: 'channel', subjectId: row.id, props: { platform: 'rubika', botId, discovery: true } });
    await (0, audit_js_1.audit)({ action: 'channel.connect', actorId: tenantId, subjectType: 'channel', subjectId: row.id, meta: { platform: 'rubika', botId, discovery: true } });
    return toChannelDto(row);
}
/**
 * Handles a Rubika discovery command before normal bot-event processing. Returns true
 * only when a matching discovery attempt existed; successful binding is synchronous.
 */
async function handleRubikaChannelDiscovery(bot, body, token) {
    if (bot.platform !== 'rubika')
        return false;
    const extracted = extractRubikaDiscoveryMessage(body);
    if (!extracted)
        return false;
    const marker = parseRubikaDiscoveryCommand(extracted.text);
    if (!marker || !extracted.chatId)
        return false;
    const redis = (0, connection_js_1.getRedis)();
    const indexKey = discoveryCommandKey(bot.tenantId, bot.id, marker);
    const discoveryId = await redis.get(indexKey);
    if (!discoveryId)
        return false;
    const key = discoveryKey(discoveryId);
    const lockKey = discoveryLockKey(discoveryId);
    const lockValue = `${process.pid}:${(0, ids_js_2.newToken)(10)}`;
    if (await redis.set(lockKey, lockValue, 'EX', 60, 'NX') !== 'OK')
        return true;
    try {
        const state = parseDiscovery(await redis.get(key));
        if (!state || state.tenantId !== bot.tenantId || state.botId !== bot.id || state.status === 'COMPLETED')
            return true;
        if (Date.parse(state.expiresAt) <= Date.now()) {
            state.status = 'ERROR';
            state.lastError = 'زمان شناسایی این درخواست تمام شده است. از صفحه کانال‌ها یک درخواست جدید شروع کنید.';
            await saveDiscovery(state);
            return true;
        }
        state.status = 'PROCESSING';
        state.lastError = null;
        await saveDiscovery(state);
        try {
            const provider = (0, index_js_1.getProvider)('rubika');
            const chat = await provider.getChat(token, extracted.chatId);
            const channel = await bindVerifiedRubikaChannel(bot.tenantId, bot.id, chat, state.title, state.publicRef);
            state.status = 'COMPLETED';
            state.channelId = channel.id;
            state.channelRef = channel.channelRef;
            state.channelTitle = channel.title;
            state.lastError = null;
            await saveDiscovery(state);
        }
        catch (err) {
            const mapped = mapChannelProviderError(err);
            state.status = 'ERROR';
            state.lastError = mapped.message;
            await saveDiscovery(state);
        }
        return true;
    }
    finally {
        await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, lockValue).catch(() => undefined);
    }
}
function extractRubikaDiscoveryMessage(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return null;
    const root = body;
    const update = root.update && typeof root.update === 'object' ? root.update : null;
    const inline = root.inline_message && typeof root.inline_message === 'object' ? root.inline_message : null;
    const source = update ?? inline;
    if (!source)
        return null;
    const msg = update && source.new_message && typeof source.new_message === 'object' ? source.new_message : source;
    const text = typeof msg.text === 'string' ? msg.text : '';
    const chatId = typeof source.chat_id === 'string' && source.chat_id.length <= 190 ? source.chat_id
        : typeof msg.chat_id === 'string' && msg.chat_id.length <= 190 ? msg.chat_id : null;
    if (!text || !chatId)
        return null;
    return { text, chatId };
}
function affectedRowsOf(result) {
    if (Array.isArray(result)) {
        const head = result[0];
        return typeof head?.affectedRows === 'number' ? head.affectedRows : 0;
    }
    const head = result;
    return typeof head?.affectedRows === 'number' ? head.affectedRows : 0;
}
function mapChannelProviderError(err) {
    if (err instanceof errors_js_1.AppError)
        return err;
    const cls = err?.providerClass;
    const msg = err?.userMessageFa;
    if (cls === 'UNAUTHORIZED')
        return new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAUTHORIZED());
    if (cls === 'RATE_LIMITED')
        return new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_RATE_LIMITED());
    if (cls === 'TRANSIENT')
        return new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
    if (cls === 'NOT_FOUND' || cls === 'BLOCKED' || cls === 'VALIDATION') {
        if (typeof msg === 'string' && msg.trim())
            return new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(msg));
    }
    if (typeof msg === 'string' && msg.trim())
        return new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(msg));
    return new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
}
function toChannelDto(row) {
    return {
        id: row.id,
        platform: row.platform,
        channelRef: row.channelRef,
        title: row.title,
        type: row.type,
        mode: row.mode,
        botId: row.botId,
        status: row.status,
        health: row.healthJson ?? null,
        lastVerifiedAt: row.lastVerifiedAt,
        createdAt: row.createdAt,
    };
}
async function listChannels(tenantId) {
    const db = (0, client_js_1.getDb)();
    const rows = await db
        .select()
        .from(schema_js_1.channels)
        .where((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.channels.createdAt));
    return rows.map(toChannelDto);
}
async function resolveSingleActiveBot(tenantId, platform) {
    const rows = await (0, client_js_1.getDb)()
        .select({ id: schema_js_1.bots.id })
        .from(schema_js_1.bots)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, platform), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE')))
        .limit(2);
    if (rows.length === 1 && rows[0])
        return rows[0].id;
    if (rows.length > 1) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای این پلتفرم بیش از یک ربات فعال دارید؛ ربات مقصد کانال را مشخص کنید.'));
    }
    return null;
}
/**
 * Connect a channel. ACTIVE is only granted after the provider proves both bot
 * identity and destination reachability via getChat; no test message is sent.
 */
async function connectChannel(tenantId, input, meta = {}) {
    const db = (0, client_js_1.getDb)();
    const platform = input.platform;
    const channelRef = normalizeChannelRef(platform, input.channelRef);
    const title = input.title.trim();
    if (channelRef.length < 2 || channelRef.length > 190) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('شناسهٔ کانال نامعتبر است.'));
    }
    if (title.length < 1 || title.length > 190) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('عنوان کانال الزامی است.'));
    }
    // The linked bot must belong to this tenant, be on the same platform and be ACTIVE.
    let botId = null;
    if (input.botId) {
        const [bot] = await db
            .select({ id: schema_js_1.bots.id })
            .from(schema_js_1.bots)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, input.botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, platform), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE')))
            .limit(1);
        if (!bot) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ربات انتخاب‌شده برای این پلتفرم معتبر یا فعال نیست.'));
        }
        botId = bot.id;
    }
    else {
        botId = await resolveSingleActiveBot(tenantId, platform);
    }
    // Anti-cheat registry claim: claim (platform, channel_ref) globally.
    // IF-guard keeps an existing foreign claim intact even if the upsert races.
    const now = new Date();
    let health = { ok: false, verifiedVia: 'pending_bot' };
    let verifiedAt = null;
    if (botId) {
        const [botRow] = await db.select().from(schema_js_1.bots).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, platform), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE'))).limit(1);
        if (!botRow)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ربات انتخاب‌شده دیگر فعال نیست؛ دوباره تلاش کنید.'));
        try {
            const provider = (0, index_js_1.getProvider)(platform);
            const token = (0, encryption_js_1.decryptSecret)(botRow.tokenEncrypted);
            const identity = await provider.verifyBot(token);
            const chat = await provider.getChat(token, channelRef);
            if (platform === 'rubika' && String(chat.type ?? '').toLowerCase() !== 'channel') {
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مقصد انتخاب‌شده در روبیکا یک کانال نیست.'));
            }
            health = { ok: true, verifiedVia: 'provider_get_chat', botId: botRow.id, botUsername: identity.username, destinationId: chat.id, destinationType: chat.type, destinationTitle: chat.title, destinationUsername: chat.username };
            verifiedAt = now;
        }
        catch (err) {
            throw mapChannelProviderError(err);
        }
    }
    const status = botId ? 'ACTIVE' : 'PENDING_VERIFY';
    await db.transaction(async (tx) => {
        // Serialize quota-sensitive channel creation/reconnection per tenant. This
        // closes the check-then-insert race where concurrent requests could exceed
        // the plan's max_channels value.
        await tx.select({ id: schema_js_1.users.id }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, tenantId)).limit(1).for('update');
        if (botId) {
            const [lockedBot] = await tx.select({ id: schema_js_1.bots.id }).from(schema_js_1.bots)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, platform)))
                .limit(1).for('update');
            if (!lockedBot)
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ربات انتخاب‌شده یافت نشد.'));
            const [active] = await tx.select({ id: schema_js_1.bots.id }).from(schema_js_1.bots)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE'))).limit(1);
            if (!active)
                throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('وضعیت ربات همزمان تغییر کرده است؛ دوباره تلاش کنید.'));
        }
        const [existing] = await tx
            .select({ id: schema_js_1.channels.id })
            .from(schema_js_1.channels)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.platform, platform), (0, drizzle_orm_1.eq)(schema_js_1.channels.channelRef, channelRef)))
            .limit(1);
        if (!existing)
            await (0, plan_service_js_1.assertWithinLimit)(tenantId, 'channels');
        await tx
            .insert(schema_js_1.channelRegistry)
            .values({ platform, channelRef, tenantId, claimedAt: now })
            .onDuplicateKeyUpdate({
            set: {
                tenantId: (0, drizzle_orm_1.sql) `IF(${schema_js_1.channelRegistry.tenantId} IS NULL OR ${schema_js_1.channelRegistry.tenantId} = ${tenantId}, ${tenantId}, ${schema_js_1.channelRegistry.tenantId})`,
                claimedAt: (0, drizzle_orm_1.sql) `IF(${schema_js_1.channelRegistry.tenantId} IS NULL OR ${schema_js_1.channelRegistry.tenantId} = ${tenantId}, ${now}, ${schema_js_1.channelRegistry.claimedAt})`,
                releasedAt: (0, drizzle_orm_1.sql) `IF(${schema_js_1.channelRegistry.tenantId} IS NULL OR ${schema_js_1.channelRegistry.tenantId} = ${tenantId}, NULL, ${schema_js_1.channelRegistry.releasedAt})`,
            },
        });
        const [claim] = await tx
            .select()
            .from(schema_js_1.channelRegistry)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelRegistry.platform, platform), (0, drizzle_orm_1.eq)(schema_js_1.channelRegistry.channelRef, channelRef)))
            .limit(1);
        if (claim && claim.tenantId && claim.tenantId !== tenantId) {
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('این کانال قبلاً توسط کاربر دیگری ثبت شده است.'));
        }
        await tx
            .insert(schema_js_1.channels)
            .values({
            id: (0, ids_js_1.newId)(),
            tenantId,
            platform,
            channelRef,
            title,
            status,
            botId,
            healthJson: health,
            lastVerifiedAt: botId ? now : null,
        })
            .onDuplicateKeyUpdate({
            set: {
                title,
                botId,
                status,
                healthJson: health,
                lastVerifiedAt: verifiedAt,
                updatedAt: now,
            },
        });
    });
    const [row] = await db
        .select()
        .from(schema_js_1.channels)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.platform, platform), (0, drizzle_orm_1.eq)(schema_js_1.channels.channelRef, channelRef)))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    await (0, events_js_1.emitEvent)({ name: 'channel.created', tenantId, subjectType: 'channel', subjectId: row.id, props: { platform } });
    if (row.status === 'ACTIVE') {
        await (0, events_js_1.emitEvent)({ name: 'channel.connected', tenantId, subjectType: 'channel', subjectId: row.id, props: { platform } });
    }
    await (0, audit_js_1.audit)({
        action: 'channel.connect',
        actorId: meta.actorId ?? null,
        actorRole: meta.actorRole ?? null,
        subjectType: 'channel',
        subjectId: row.id,
        ip: meta.ip ?? undefined,
        meta: { platform },
    });
    return toChannelDto(row);
}
/**
 * Explicit verification: mark ACTIVE + healthy. The real-world health signal
 * is bot membership at connect time / first successful send — this endpoint
 * lets the user confirm the channel is live without Postyar sending a message.
 */
async function verifyChannel(tenantId, channelId, meta = {}) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select()
        .from(schema_js_1.channels)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.id, channelId), (0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId)))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کانال'));
    const now = new Date();
    let botId = row.botId;
    if (!botId) {
        botId = await resolveSingleActiveBot(tenantId, row.platform);
    }
    else {
        const [activeBot] = await db
            .select({ id: schema_js_1.bots.id })
            .from(schema_js_1.bots)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, row.platform), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE')))
            .limit(1);
        if (!activeBot)
            botId = null;
    }
    if (!botId) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('این کانال به یک ربات فعال متصل نیست. ابتدا ربات فعال همان پلتفرم را به کانال اختصاص دهید.'));
    }
    const [botRow] = await db
        .select()
        .from(schema_js_1.bots)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, row.platform), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE')))
        .limit(1);
    if (!botRow)
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('ربات مقصد دیگر فعال نیست؛ دوباره تلاش کنید.'));
    let health;
    try {
        const normalizedRef = normalizeChannelRef(row.platform, row.channelRef);
        const provider = (0, index_js_1.getProvider)(row.platform);
        const token = (0, encryption_js_1.decryptSecret)(botRow.tokenEncrypted);
        const identity = await provider.verifyBot(token);
        const chat = await provider.getChat(token, normalizedRef);
        health = { ok: true, verifiedVia: 'provider_get_chat', botId: botRow.id, botUsername: identity.username, destinationId: chat.id, destinationType: chat.type, destinationTitle: chat.title, destinationUsername: chat.username };
    }
    catch (err) {
        throw mapChannelProviderError(err);
    }
    await db.transaction(async (tx) => {
        const [lockedBot] = await tx.select({ id: schema_js_1.bots.id }).from(schema_js_1.bots)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, row.platform)))
            .limit(1).for('update');
        if (!lockedBot)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('ربات'));
        const [active] = await tx.select({ id: schema_js_1.bots.id }).from(schema_js_1.bots).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE'))).limit(1);
        if (!active)
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('وضعیت ربات همزمان تغییر کرده است؛ دوباره تلاش کنید.'));
        const changed = await tx.update(schema_js_1.channels).set({ botId, status: 'ACTIVE', lastVerifiedAt: now, healthJson: health })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.id, channelId), (0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId)));
        if (affectedRowsOf(changed) === 0)
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('وضعیت کانال همزمان تغییر کرده است؛ دوباره تلاش کنید.'));
    });
    const [updated] = await db.select().from(schema_js_1.channels).where((0, drizzle_orm_1.eq)(schema_js_1.channels.id, channelId)).limit(1);
    if (!updated)
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    await (0, events_js_1.emitEvent)({ name: 'channel.connected', tenantId, subjectType: 'channel', subjectId: channelId, props: { platform: row.platform } });
    await (0, audit_js_1.audit)({
        action: 'channel.verify',
        actorId: meta.actorId ?? null,
        actorRole: meta.actorRole ?? null,
        subjectType: 'channel',
        subjectId: channelId,
        ip: meta.ip ?? undefined,
    });
    return toChannelDto(updated);
}
/**
 * Disconnect: status DISABLED. The channel_registry claim is intentionally
 * KEPT (anti-cheat lock persists across reconnects); releasing a claim is an
 * explicit admin action, never automatic.
 */
async function disconnectChannel(tenantId, channelId, meta = {}) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select()
        .from(schema_js_1.channels)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.id, channelId), (0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId)))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کانال'));
    if (row.status !== 'DISABLED') {
        await db.update(schema_js_1.channels).set({ status: 'DISABLED' }).where((0, drizzle_orm_1.eq)(schema_js_1.channels.id, channelId));
        await (0, events_js_1.emitEvent)({ name: 'channel.disconnected', tenantId, subjectType: 'channel', subjectId: channelId, props: { platform: row.platform } });
        await (0, audit_js_1.audit)({
            action: 'channel.disconnect',
            actorId: meta.actorId ?? null,
            actorRole: meta.actorRole ?? null,
            subjectType: 'channel',
            subjectId: channelId,
            ip: meta.ip ?? undefined,
        });
    }
    return { ...toChannelDto(row), status: 'DISABLED' };
}
async function updateChannel(tenantId, channelId, input, meta = {}) {
    const db = (0, client_js_1.getDb)();
    const title = input.title.trim();
    if (title.length < 1 || title.length > 190) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('عنوان کانال نامعتبر است.'));
    }
    const [row] = await db
        .select()
        .from(schema_js_1.channels)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.id, channelId), (0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId)))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کانال'));
    const nextBotId = input.botId === undefined ? row.botId : input.botId;
    const bindingChanged = nextBotId !== row.botId;
    let bindingPatch = {};
    if (bindingChanged && nextBotId) {
        const [bot] = await db.select().from(schema_js_1.bots)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, nextBotId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, row.platform), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE')))
            .limit(1);
        if (!bot)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ربات انتخاب‌شده برای این کانال معتبر یا فعال نیست.'));
        try {
            const provider = (0, index_js_1.getProvider)(row.platform);
            const token = (0, encryption_js_1.decryptSecret)(bot.tokenEncrypted);
            const identity = await provider.verifyBot(token);
            const chat = await provider.getChat(token, row.channelRef);
            bindingPatch = { status: 'ACTIVE', healthJson: { ok: true, verifiedVia: 'provider_get_chat', botId: bot.id, botUsername: identity.username, destinationId: chat.id, destinationType: chat.type, destinationTitle: chat.title, destinationUsername: chat.username }, lastVerifiedAt: new Date() };
        }
        catch (err) {
            throw mapChannelProviderError(err);
        }
    }
    else if (bindingChanged) {
        bindingPatch = { status: 'PENDING_VERIFY', healthJson: null, lastVerifiedAt: null };
    }
    if (bindingChanged && nextBotId) {
        await db.transaction(async (tx) => {
            const [lockedBot] = await tx.select({ id: schema_js_1.bots.id }).from(schema_js_1.bots)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, nextBotId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, row.platform)))
                .limit(1).for('update');
            if (!lockedBot)
                throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('ربات'));
            const [active] = await tx.select({ id: schema_js_1.bots.id }).from(schema_js_1.bots).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, nextBotId), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE'))).limit(1);
            if (!active)
                throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('وضعیت ربات همزمان تغییر کرده است؛ دوباره تلاش کنید.'));
            const changed = await tx.update(schema_js_1.channels).set({ title, botId: nextBotId, ...bindingPatch }).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.id, channelId), (0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId)));
            if (affectedRowsOf(changed) === 0)
                throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('وضعیت کانال همزمان تغییر کرده است؛ دوباره تلاش کنید.'));
        });
    }
    else {
        await db.update(schema_js_1.channels).set({ title, botId: nextBotId, ...bindingPatch }).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.id, channelId), (0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId)));
    }
    await (0, events_js_1.emitEvent)({ name: 'channel.updated', tenantId, subjectType: 'channel', subjectId: channelId, props: { botChanged: bindingChanged } });
    await (0, audit_js_1.audit)({
        action: 'channel.update',
        actorId: meta.actorId ?? null,
        actorRole: meta.actorRole ?? null,
        subjectType: 'channel',
        subjectId: channelId,
        ip: meta.ip ?? undefined,
    });
    const [updated] = await db
        .select()
        .from(schema_js_1.channels)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.id, channelId), (0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId)))
        .limit(1);
    if (!updated)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کانال'));
    return toChannelDto(updated);
}
