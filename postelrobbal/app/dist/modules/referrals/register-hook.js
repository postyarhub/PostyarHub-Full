"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onUserRegistered = onUserRegistered;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const referral_service_js_1 = require("./referral.service.js");
/**
 * Registration side-effect (§36): when a referred user completes
 * registration, the referrer earns the one-time REGISTER reward (100 points).
 * Idempotent via uq_referral_rewards(referral_id, 'REGISTER'); failures are
 * swallowed — registration must never break because of the reward.
 */
async function onUserRegistered(userId) {
    const db = (0, client_js_1.getDb)();
    const [referral] = await db
        .select({ id: schema_js_1.referrals.id, referrerTenantId: schema_js_1.referrals.referrerTenantId })
        .from(schema_js_1.referrals)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.referrals.referredTenantId, userId), (0, drizzle_orm_1.eq)(schema_js_1.referrals.state, 'REGISTERED')))
        .limit(1);
    if (!referral)
        return;
    await (0, referral_service_js_1.awardRegisterRewardForReferral)(referral.id, referral.referrerTenantId);
}
