"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.outboxRow = outboxRow;
exports.relayOutbox = relayOutbox;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../db/client.js");
const schema_js_1 = require("../db/schema.js");
const ids_js_1 = require("./ids.js");
const logger_js_1 = require("./logger.js");
const connection_js_1 = require("../queue/connection.js");
function outboxRow(input) {
    return {
        id: (0, ids_js_1.newId)(),
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payloadJson: input.payload,
        state: 'PENDING',
        attempts: 0,
    };
}
const log = (0, logger_js_1.createLogger)('outbox-relay');
const OUTBOX_RELAY_LOCK_KEY = 'postyar:outbox-relay:lock';
const OUTBOX_RELAY_LOCK_TTL_SECONDS = 120;
/** Relay pending outbox events to the queue. Called by worker loop. */
async function relayOutbox(dispatcher, batchSize = 50) {
    const redis = (0, connection_js_1.getRedis)();
    const lockValue = `${process.pid}:${(0, ids_js_1.newToken)(12)}`;
    const lock = await redis.set(OUTBOX_RELAY_LOCK_KEY, lockValue, 'EX', OUTBOX_RELAY_LOCK_TTL_SECONDS, 'NX');
    if (lock !== 'OK') {
        log.debug({}, 'outbox_relay_lock_busy');
        return 0;
    }
    try {
        const db = (0, client_js_1.getDb)();
        const pending = await db
            .select()
            .from(schema_js_1.outboxEvents)
            .where((0, drizzle_orm_1.eq)(schema_js_1.outboxEvents.state, 'PENDING'))
            .orderBy((0, drizzle_orm_1.asc)(schema_js_1.outboxEvents.createdAt))
            .limit(batchSize);
        let dispatched = 0;
        for (const ev of pending) {
            try {
                await dispatcher.dispatch({
                    id: ev.id,
                    eventType: ev.eventType,
                    payloadJson: ev.payloadJson ?? {},
                    aggregateId: ev.aggregateId,
                });
                await db
                    .update(schema_js_1.outboxEvents)
                    .set({ state: 'DISPATCHED', dispatchedAt: new Date() })
                    .where((0, drizzle_orm_1.eq)(schema_js_1.outboxEvents.id, ev.id));
                dispatched++;
            }
            catch (err) {
                const nextAttempts = ev.attempts + 1;
                const terminal = nextAttempts >= 10;
                await db
                    .update(schema_js_1.outboxEvents)
                    .set({ attempts: nextAttempts, state: terminal ? 'FAILED' : 'PENDING' })
                    .where((0, drizzle_orm_1.eq)(schema_js_1.outboxEvents.id, ev.id));
                log.error({
                    outboxId: ev.id,
                    aggregateType: ev.aggregateType,
                    aggregateId: ev.aggregateId,
                    eventType: ev.eventType,
                    attempts: nextAttempts,
                    terminal,
                    errorName: err instanceof Error ? err.name : 'UnknownError',
                    errorMessage: String(err instanceof Error ? err.message : err ?? '').slice(0, 240),
                }, terminal ? 'outbox_dispatch_terminal_failure' : 'outbox_dispatch_failed');
            }
        }
        return dispatched;
    }
    finally {
        await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, OUTBOX_RELAY_LOCK_KEY, lockValue).catch(() => undefined);
    }
}
