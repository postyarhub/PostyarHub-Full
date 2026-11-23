"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startBotPollingWorker = startBotPollingWorker;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../db/client.js");
const schema_js_1 = require("../db/schema.js");
const connection_js_1 = require("../queue/connection.js");
const index_js_1 = require("../providers/index.js");
const encryption_js_1 = require("../security/encryption.js");
const bot_service_js_1 = require("../modules/bots/bot.service.js");
const ids_js_1 = require("../core/ids.js");
const logger_js_1 = require("../core/logger.js");
const env_js_1 = require("../config/env.js");
const log = (0, logger_js_1.createLogger)('bot-poller');
const POLL_INTERVAL_MS = 2_000;
const LOCK_TTL_SECONDS = 60;
const REDIS_PREFIX = 'postyar:botpoll:';
const BOT_POLL_CURSOR_KEY = `${REDIS_PREFIX}cursor`;
function updateIdOf(update) {
    if (!update || typeof update !== 'object' || Array.isArray(update))
        return null;
    const raw = update.update_id;
    const id = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    return Number.isSafeInteger(id) && id >= 0 ? id : null;
}
async function pollOne(bot) {
    // Rubika is webhook-first in Postyar; never revive polling for legacy rows.
    if (bot.platform === 'rubika')
        return;
    const provider = (0, index_js_1.getProvider)(bot.platform);
    if (!provider.capabilities().polling || typeof provider.fetchUpdates !== 'function')
        return;
    const redis = (0, connection_js_1.getRedis)();
    const lockKey = `${REDIS_PREFIX}lock:${bot.id}`;
    const lockValue = `${process.pid}:${(0, ids_js_1.newToken)(12)}`;
    const lock = await redis.set(lockKey, lockValue, 'EX', LOCK_TTL_SECONDS, 'NX');
    if (lock !== 'OK')
        return;
    try {
        const offsetKey = `${REDIS_PREFIX}offset:${bot.id}`;
        const stored = await redis.get(offsetKey);
        if (typeof provider.fetchUpdates === 'function') {
            let offset = stored && /^\d+$/.test(stored) ? Number(stored) : 0;
            if (!Number.isSafeInteger(offset) || offset < 0)
                offset = 0;
            const updates = await provider.fetchUpdates((0, encryption_js_1.decryptSecret)(bot.tokenEncrypted), offset);
            let nextOffset = offset;
            for (const update of updates) {
                await (0, bot_service_js_1.ingestBotPollingUpdate)(bot.id, update);
                const updateId = updateIdOf(update);
                if (updateId !== null && updateId + 1 > nextOffset)
                    nextOffset = updateId + 1;
            }
            if (nextOffset > offset)
                await redis.set(offsetKey, String(nextOffset));
        }
    }
    finally {
        await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, lockValue).catch(() => undefined);
    }
}
let timer = null;
let running = false;
async function tick() {
    if (running)
        return;
    running = true;
    try {
        const db = (0, client_js_1.getDb)();
        const redis = (0, connection_js_1.getRedis)();
        const cursor = await redis.get(BOT_POLL_CURSOR_KEY).catch(() => null);
        const pollingFilter = (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE'), (0, drizzle_orm_1.eq)(schema_js_1.bots.mode, 'POLLING'));
        let rows = await db
            .select({ id: schema_js_1.bots.id, platform: schema_js_1.bots.platform, tokenEncrypted: schema_js_1.bots.tokenEncrypted })
            .from(schema_js_1.bots)
            .where((0, drizzle_orm_1.and)(pollingFilter, ...(cursor ? [(0, drizzle_orm_1.gt)(schema_js_1.bots.id, cursor)] : [])))
            .orderBy((0, drizzle_orm_1.asc)(schema_js_1.bots.id))
            .limit(100);
        // Wrap around after the last page. The persistent cursor prevents permanent
        // starvation when more than 100 polling bots are connected.
        if (rows.length === 0 && cursor) {
            rows = await db
                .select({ id: schema_js_1.bots.id, platform: schema_js_1.bots.platform, tokenEncrypted: schema_js_1.bots.tokenEncrypted })
                .from(schema_js_1.bots)
                .where(pollingFilter)
                .orderBy((0, drizzle_orm_1.asc)(schema_js_1.bots.id))
                .limit(100);
        }
        if (rows.length > 0) {
            await redis.set(BOT_POLL_CURSOR_KEY, rows[rows.length - 1].id).catch(() => undefined);
        }
        const batchSize = (0, env_js_1.loadEnv)().BOT_POLL_CONCURRENCY;
        for (let i = 0; i < rows.length; i += batchSize) {
            const batch = rows.slice(i, i + batchSize);
            await Promise.all(batch.map((bot) => pollOne(bot).catch((err) => {
                log.warn({ botId: bot.id, err: err instanceof Error ? err.message : 'poll_failed' }, 'bot_poll_failed');
            })));
        }
    }
    catch (err) {
        // A database/Redis failure in the polling coordinator must not escape the
        // fire-and-forget timer and terminate the single production worker.
        log.error({ err }, 'bot_poll_tick_failed');
    }
    finally {
        running = false;
    }
}
function startBotPollingWorker() {
    void tick();
    timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    timer.unref?.();
    return {
        close: async () => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        },
    };
}
