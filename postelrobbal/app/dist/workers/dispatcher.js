"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.outboxDispatcher = void 0;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../db/client.js");
const schema_js_1 = require("../db/schema.js");
const queues_js_1 = require("../queue/queues.js");
/**
 * Outbox relay dispatcher (§125). Maps durable outbox rows onto BullMQ jobs:
 *   - post.publish       → one 'deliver' job per PENDING post_target
 *   - wordpress.publish  → single 'deliver-product' job (payload forwarded;
 *                          created by the wordpress module, payloadJson =
 *                          {tenantId, siteId, productId, channelId, ...})
 * Unknown event types throw so the relay marks the row FAILED (poison guard).
 */
exports.outboxDispatcher = {
    async dispatch(event) {
        if (event.eventType === 'post.publish') {
            const db = (0, client_js_1.getDb)();
            const targets = await db
                .select({ id: schema_js_1.postTargets.id })
                .from(schema_js_1.postTargets)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.postId, event.aggregateId), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'PENDING')))
                .limit(500);
            for (let i = 0; i < targets.length; i++) {
                const target = targets[i];
                // Stagger enqueued delivery jobs slightly (300ms apart) so concurrent sends to the
                // same provider or bot (e.g. 2 Bale channels or 2 Telegram channels) do not flood
                // the external provider API simultaneously and trigger rate limits or timeouts.
                await (0, queues_js_1.enqueue)('delivery', 'deliver', { targetId: target.id }, { jobId: `deliver:${target.id}:${event.id}`, delayMs: i * 300 });
            }
            return;
        }
        if (event.eventType === 'wordpress.publish') {
            await (0, queues_js_1.enqueue)('delivery', 'deliver-product', { payloadJson: event.payloadJson }, { jobId: `wp:${event.id}` });
            return;
        }
        if (event.eventType === 'ai.run') {
            const jobId = typeof event.payloadJson.jobId === 'string' && event.payloadJson.jobId.length > 0
                ? event.payloadJson.jobId
                : event.aggregateId;
            await (0, queues_js_1.enqueue)('ai-jobs', 'run', { jobId }, { jobId: `ai:${jobId}` });
            return;
        }
        throw new Error(`UNKNOWN_OUTBOX_EVENT_TYPE: ${event.eventType}`);
    },
};
