"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runIdempotent = runIdempotent;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../db/client.js");
const schema_js_1 = require("../db/schema.js");
async function runIdempotent(scope, key, ttlSeconds, fn, serialize = (v) => v, deserialize = (raw) => raw) {
    const db = (0, client_js_1.getDb)();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.max(1, ttlSeconds) * 1000);
    // A crashed worker must not strand a key for the full result-retention TTL.
    // The lease is only for active execution; successful results keep the full TTL.
    const leaseExpiresAt = new Date(now.getTime() + Math.min(Math.max(1, ttlSeconds), 300) * 1000);
    await db
        .delete(schema_js_1.idempotencyKeys)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.idempotencyKeys.scope, scope), (0, drizzle_orm_1.lt)(schema_js_1.idempotencyKeys.expiresAt, now)));
    try {
        await db.insert(schema_js_1.idempotencyKeys).values({
            scope,
            idemKey: key,
            state: 'IN_PROGRESS',
            expiresAt: leaseExpiresAt,
        });
    }
    catch (insertError) {
        const insertCode = insertError?.code;
        const insertErrno = insertError?.errno;
        // Only a genuine uniqueness collision is an idempotency replay. Database
        // outages, lock timeouts and malformed writes must retain their real error.
        if (insertCode !== 'ER_DUP_ENTRY' && insertErrno !== 1062)
            throw insertError;
        // Duplicate: read existing state
        const [existing] = await db
            .select()
            .from(schema_js_1.idempotencyKeys)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.idempotencyKeys.scope, scope), (0, drizzle_orm_1.eq)(schema_js_1.idempotencyKeys.idemKey, key)))
            .limit(1);
        if (existing && existing.state === 'COMPLETED') {
            return { value: deserialize(existing.resultJson), replayed: true };
        }
        throw new Error('IDEMPOTENCY_IN_PROGRESS');
    }
    try {
        const value = await fn();
        await db
            .update(schema_js_1.idempotencyKeys)
            .set({ state: 'COMPLETED', resultJson: serialize(value), expiresAt })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.idempotencyKeys.scope, scope), (0, drizzle_orm_1.eq)(schema_js_1.idempotencyKeys.idemKey, key)));
        return { value, replayed: false };
    }
    catch (err) {
        await db
            .delete(schema_js_1.idempotencyKeys)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.idempotencyKeys.scope, scope), (0, drizzle_orm_1.eq)(schema_js_1.idempotencyKeys.idemKey, key)));
        throw err;
    }
}
