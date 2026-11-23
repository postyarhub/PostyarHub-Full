"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REGISTER_REWARD_POINTS = void 0;
exports.myReferral = myReferral;
exports.awardRegisterReward = awardRegisterReward;
exports.awardRegisterRewardForReferral = awardRegisterRewardForReferral;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const events_js_1 = require("../../core/events.js");
const auth_service_js_1 = require("../auth/auth.service.js");
const wallet_service_js_1 = require("../wallet/wallet.service.js");
const system_settings_service_js_1 = require("../admin/system-settings.service.js");
/** Fallback register reward — overridden by the admin setting key 'referral'. */
exports.REGISTER_REWARD_POINTS = 100;
/** Own referral dashboard (privacy: first name + date only — §173). */
async function myReferral(tenantId) {
    const db = (0, client_js_1.getDb)();
    const code = (0, auth_service_js_1.referralCodeFor)(tenantId);
    const rows = await db
        .select({
        referralId: schema_js_1.referrals.id,
        firstName: schema_js_1.users.firstName,
        createdAt: schema_js_1.referrals.createdAt,
    })
        .from(schema_js_1.referrals)
        .innerJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.referrals.referredTenantId))
        .where((0, drizzle_orm_1.eq)(schema_js_1.referrals.referrerTenantId, tenantId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.referrals.createdAt))
        .limit(200);
    const rewardRows = await db
        .select({
        id: schema_js_1.referralRewards.id,
        referralId: schema_js_1.referralRewards.referralId,
        rewardKind: schema_js_1.referralRewards.rewardKind,
        amount: schema_js_1.referralRewards.amount,
        createdAt: schema_js_1.referralRewards.createdAt,
    })
        .from(schema_js_1.referralRewards)
        .innerJoin(schema_js_1.referrals, (0, drizzle_orm_1.eq)(schema_js_1.referrals.id, schema_js_1.referralRewards.referralId))
        .where((0, drizzle_orm_1.eq)(schema_js_1.referrals.referrerTenantId, tenantId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.referralRewards.createdAt))
        .limit(200);
    const rewardedReferrals = new Set(rewardRows.map((r) => r.referralId));
    return {
        code,
        referred: rows.map((r) => ({ firstName: r.firstName, joinedAt: r.createdAt })),
        rewards: rewardRows.map((r) => ({
            id: r.id,
            rewardKind: r.rewardKind,
            amount: r.amount,
            createdAt: r.createdAt,
        })),
        totalPoints: rewardRows.reduce((sum, r) => sum + r.amount, 0),
        pointsBalance: await (0, wallet_service_js_1.getPointsBalance)(tenantId),
        pendingCount: rows.filter((r) => !rewardedReferrals.has(r.referralId)).length,
    };
}
/**
 * Registration reward: points per REGISTERED referral, exactly-once via
 * uq_referral_rewards(referral_id, reward_kind). Never flips the referral
 * state — REWARDED is reserved for the first-purchase reward.
 */
async function awardRegisterReward(referrerTenantId) {
    const db = (0, client_js_1.getDb)();
    const pending = await db
        .select({ id: schema_js_1.referrals.id })
        .from(schema_js_1.referrals)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.referrals.referrerTenantId, referrerTenantId), (0, drizzle_orm_1.eq)(schema_js_1.referrals.state, 'REGISTERED')))
        .limit(50);
    let awarded = 0;
    for (const referral of pending) {
        awarded += await awardRegisterRewardForReferral(referral.id, referrerTenantId);
    }
    return awarded;
}
/**
 * Round 17: admin-configurable register reward (system_settings key 'referral',
 * field registerRewardPoints, 0..100000; round 18 adds the master `enabled`
 * toggle). Value resolution + validation now live in system-settings.service
 * (getReferralSettings) — same guards, same REGISTER_REWARD_POINTS default.
 */
/** Award for one specific referral row; idempotent (unique key + pre-check). */
async function awardRegisterRewardForReferral(referralId, referrerTenantId) {
    const db = (0, client_js_1.getDb)();
    const [existing] = await db
        .select({ id: schema_js_1.referralRewards.id })
        .from(schema_js_1.referralRewards)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.referralRewards.referralId, referralId), (0, drizzle_orm_1.eq)(schema_js_1.referralRewards.rewardKind, 'REGISTER')))
        .limit(1);
    if (existing)
        return 0;
    // Round 18: the master referral toggle. When disabled, NO reward row is
    // created — exactly-once semantics are preserved for re-enabling later.
    const settings = await (0, system_settings_service_js_1.getReferralSettings)();
    if (!settings.enabled)
        return 0;
    const points = settings.registerRewardPoints;
    try {
        await db.transaction(async (tx) => {
            await tx.insert(schema_js_1.referralRewards).values({
                id: (0, ids_js_1.newId)(),
                referralId,
                rewardKind: 'REGISTER',
                amount: points,
            });
            await (0, wallet_service_js_1.pointCreditTx)(tx, referrerTenantId, points, { type: 'referral_register', id: referralId }, 'پاداش معرفی کاربر جدید');
        });
    }
    catch (err) {
        const e = err;
        if (e?.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(String(e?.message ?? '')))
            return 0; // idempotent
        throw err;
    }
    await (0, events_js_1.emitEvent)({
        name: 'referral.rewarded',
        tenantId: referrerTenantId,
        subjectType: 'referral',
        subjectId: referralId,
        props: { rewardKind: 'REGISTER', points },
    });
    return points;
}
