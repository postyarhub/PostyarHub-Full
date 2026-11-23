"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshPostAggregate = refreshPostAggregate;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../db/client.js");
const schema_js_1 = require("../db/schema.js");
/** Recompute the post aggregate from target state. Safe to call after any target transition. */
async function refreshPostAggregate(postId) {
    const db = (0, client_js_1.getDb)();
    await db.transaction(async (tx) => {
        // Serialize aggregate recalculation itself. Without a row lock, two target
        // transitions could each calculate from an interleaved snapshot and the
        // slower refresh could overwrite a newer aggregate state. Every authoritative
        // target transition calls this function, so the second refresh re-reads after
        // the first commits and converges to the correct state.
        const [post] = await tx.select().from(schema_js_1.posts).where((0, drizzle_orm_1.eq)(schema_js_1.posts.id, postId)).limit(1).for('update');
        if (!post)
            return;
        if (post.state === 'CANCELLED' || post.state === 'DRAFT')
            return;
        const rows = await tx
            .select({ state: schema_js_1.postTargets.state })
            .from(schema_js_1.postTargets)
            .where((0, drizzle_orm_1.eq)(schema_js_1.postTargets.postId, postId));
        if (rows.length === 0)
            return;
        const sent = rows.filter((r) => r.state === 'SENT').length;
        const closed = rows.filter((r) => r.state === 'FAILED' || r.state === 'CANCELLED').length;
        const open = rows.length - sent - closed;
        let next;
        if (open > 0) {
            next = 'PUBLISHING';
        }
        else if (sent === rows.length) {
            next = 'PUBLISHED';
        }
        else if (sent > 0) {
            next = 'PARTIAL';
        }
        else {
            next = 'FAILED';
        }
        const setPublishedAt = post.publishedAt === null && (next === 'PUBLISHED' || next === 'PARTIAL' || sent > 0);
        if (next !== post.state || setPublishedAt) {
            await tx
                .update(schema_js_1.posts)
                .set({ state: next, ...(setPublishedAt ? { publishedAt: new Date() } : {}) })
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, postId), (0, drizzle_orm_1.inArray)(schema_js_1.posts.state, ['QUEUED', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'PARTIAL', 'FAILED'])));
        }
    });
}
