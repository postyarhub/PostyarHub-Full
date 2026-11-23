"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_TOTAL_DISCOUNT_PERCENT = exports.DEFAULT_PLAN_PRICING = void 0;
exports.normalizePlanFeatures = normalizePlanFeatures;
exports.normalizePlanPricing = normalizePlanPricing;
exports.hasUnexpiredSubscription = hasUnexpiredSubscription;
exports.computeSubscriptionPrice = computeSubscriptionPrice;
exports.getPlanContext = getPlanContext;
exports.assertWithinLimit = assertWithinLimit;
exports.assertFeature = assertFeature;
exports.activateSubscriptionTx = activateSubscriptionTx;
exports.activateSubscription = activateSubscription;
exports.expireDueSubscriptions = expireDueSubscriptions;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const ids_js_1 = require("../../core/ids.js");
const events_js_1 = require("../../core/events.js");
const audit_js_1 = require("../../core/audit.js");
/** Fallback free context when the seeded 'free' plan row is missing. */
const FREE_FALLBACK_LIMITS = {
    max_channels: 2,
    max_posts: 10,
    max_bots: 0,
    max_schedules: 3,
    ai_monthly: 0,
    storage_mb: 50,
};
const FREE_FALLBACK_FEATURES = {
    gold_ticker: false,
    auto_responder: false,
    woocommerce: false,
    wordpress_campaigns: false,
    content_summarization: false,
};
/**
 * Allowlist plan feature data before it crosses a runtime/API boundary.
 * Legacy api_access and any unknown keys are intentionally discarded.
 * Missing wordpress_campaigns stays missing to preserve the existing, explicit
 * backward-compatibility rule for older plans.
 */
function normalizePlanFeatures(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw
        : {};
    const clean = {
        gold_ticker: source.gold_ticker === true,
        auto_responder: source.auto_responder === true,
        woocommerce: source.woocommerce === true,
    };
    if (typeof source.wordpress_campaigns === 'boolean') {
        clean.wordpress_campaigns = source.wordpress_campaigns;
    }
    if (typeof source.content_summarization === 'boolean') {
        clean.content_summarization = source.content_summarization;
    }
    return clean;
}
/** Round 19 defaults — a plan without pricing data behaves exactly like before. */
exports.DEFAULT_PLAN_PRICING = {
    renewalDiscountPercent: 0,
    durationDiscounts: {},
};
/** Coerces any stored/legacy shape into a valid PlanPricing (never throws). */
function normalizePlanPricing(raw) {
    const src = (raw && typeof raw === 'object' ? raw : {});
    const renewal = Number(src.renewalDiscountPercent);
    const durationSrc = (src.durationDiscounts && typeof src.durationDiscounts === 'object'
        ? src.durationDiscounts
        : {});
    const durationDiscounts = {};
    for (const [k, v] of Object.entries(durationSrc)) {
        const months = Number(k);
        const pct = Number(v);
        if (Number.isInteger(months) && months >= 1 && months <= 36 && Number.isInteger(pct) && pct >= 0 && pct <= 90) {
            durationDiscounts[String(months)] = pct;
        }
    }
    return {
        renewalDiscountPercent: Number.isInteger(renewal) && renewal >= 0 && renewal <= 90 ? renewal : 0,
        durationDiscounts,
    };
}
/**
 * True when the tenant currently holds an ACTIVE subscription whose expiry is
 * still in the future. Registration seeds the free plan the same way (30 days,
 * state ACTIVE), so free-plan users qualify for the renewal/upgrade discount
 * until their free period ends — exactly the round-19 contract example.
 */
async function hasUnexpiredSubscription(tenantId) {
    const db = (0, client_js_1.getDb)();
    const [userRow] = await db.select({ role: schema_js_1.users.role }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, tenantId)).limit(1);
    if (userRow && (userRow.role === 'SUPER_ADMIN' || userRow.role === 'SUPPORT')) {
        return true;
    }
    const now = new Date();
    const [row] = await db
        .select({ id: schema_js_1.subscriptions.id })
        .from(schema_js_1.subscriptions)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.subscriptions.state, 'ACTIVE'), (0, drizzle_orm_1.lte)(schema_js_1.subscriptions.startedAt, now), (0, drizzle_orm_1.gt)(schema_js_1.subscriptions.expiresAt, now)))
        .limit(1);
    return Boolean(row);
}
/** Hard cap so stacked discounts can never exceed 90% of the list price. */
exports.MAX_TOTAL_DISCOUNT_PERCENT = 90;
/**
 * Round 19 pricing engine — single source for every checkout path (online
 * gateway, card-to-card intent, legacy checkout route).
 *  - duration discount: plan.durationDiscounts[String(months)] ?? 0;
 *  - renewal/upgrade discount: plan.renewalDiscountPercent, only when the
 *    buyer has an unexpired subscription (hasUnexpiredSubscription);
 *  - the two add up, capped at MAX_TOTAL_DISCOUNT_PERCENT;
 *  - the discount amount floors (⌊list·pct/100⌋) so the final amount is an
 *    exact integer rial value.
 */
function computeSubscriptionPrice(plan, months, hasActive) {
    const pricing = normalizePlanPricing(plan.pricingJson);
    const listAmountRial = Math.max(0, Math.floor(Number(plan.priceRial) || 0)) * Math.max(1, months);
    const durationDiscountPercent = pricing.durationDiscounts[String(months)] ?? 0;
    const renewalDiscountPercent = hasActive ? pricing.renewalDiscountPercent : 0;
    const totalDiscountPercent = Math.min(exports.MAX_TOTAL_DISCOUNT_PERCENT, durationDiscountPercent + renewalDiscountPercent);
    const discountAmountRial = Math.floor((listAmountRial * totalDiscountPercent) / 100);
    return {
        listAmountRial,
        durationDiscountPercent,
        renewalDiscountPercent,
        totalDiscountPercent,
        discountAmountRial,
        finalAmountRial: listAmountRial - discountAmountRial,
    };
}
function freeContext(free) {
    return {
        subscriptionId: null,
        planId: free?.id ?? 'free',
        planCode: free?.code ?? 'free',
        planNameFa: free?.nameFa ?? 'رایگان',
        state: 'FREE',
        startedAt: null,
        expiresAt: null,
        limits: free?.limitsJson ?? FREE_FALLBACK_LIMITS,
        features: free ? normalizePlanFeatures(free.featuresJson) : FREE_FALLBACK_FEATURES,
    };
}
/** Latest ACTIVE subscription joined with its plan; free plan when none exists. */
async function getPlanContext(tenantId) {
    const db = (0, client_js_1.getDb)();
    // Admin users (SUPER_ADMIN / SUPPORT) hold lifetime unlimited privileges (§Item-2)
    const [userRow] = await db.select({ role: schema_js_1.users.role }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, tenantId)).limit(1);
    if (userRow && (userRow.role === 'SUPER_ADMIN' || userRow.role === 'SUPPORT')) {
        return {
            subscriptionId: 'admin-lifetime',
            planId: 'admin-lifetime',
            planCode: 'lifetime_admin',
            planNameFa: 'دسترسی کامل مدیریتی (نامحدود / مادام‌العمر)',
            state: 'ACTIVE',
            startedAt: new Date(2020, 0, 1),
            expiresAt: new Date(2099, 11, 31),
            limits: {
                max_channels: 999999,
                max_posts: 0, // 0 = unlimited in PostYar
                max_bots: 999999,
                max_schedules: 0, // 0 = unlimited in PostYar
                ai_monthly: 999999,
                storage_mb: 999999,
            },
            features: {
                gold_ticker: true,
                auto_responder: true,
                woocommerce: true,
                wordpress_campaigns: true,
                content_summarization: true,
            },
        };
    }
    // Use one timestamp for both boundaries. Future-dated renewal rows must not
    // activate early or mask the currently effective subscription.
    const now = new Date();
    const [row] = await db
        .select({
        subscriptionId: schema_js_1.subscriptions.id,
        startedAt: schema_js_1.subscriptions.startedAt,
        expiresAt: schema_js_1.subscriptions.expiresAt,
        planId: schema_js_1.plans.id,
        planCode: schema_js_1.plans.code,
        planNameFa: schema_js_1.plans.nameFa,
        limitsJson: schema_js_1.plans.limitsJson,
        featuresJson: schema_js_1.plans.featuresJson,
    })
        .from(schema_js_1.subscriptions)
        .innerJoin(schema_js_1.plans, (0, drizzle_orm_1.eq)(schema_js_1.plans.id, schema_js_1.subscriptions.planId))
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.subscriptions.state, 'ACTIVE'), (0, drizzle_orm_1.lte)(schema_js_1.subscriptions.startedAt, now), (0, drizzle_orm_1.gt)(schema_js_1.subscriptions.expiresAt, now)))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.subscriptions.startedAt), (0, drizzle_orm_1.desc)(schema_js_1.subscriptions.createdAt))
        .limit(1);
    if (row) {
        return {
            subscriptionId: row.subscriptionId,
            planId: row.planId,
            planCode: row.planCode,
            planNameFa: row.planNameFa,
            state: 'ACTIVE',
            startedAt: row.startedAt,
            expiresAt: row.expiresAt,
            limits: row.limitsJson,
            features: normalizePlanFeatures(row.featuresJson),
        };
    }
    const [freePlan] = await db.select().from(schema_js_1.plans).where((0, drizzle_orm_1.eq)(schema_js_1.plans.code, 'free')).limit(1);
    return freeContext(freePlan);
}
const QUOTA_LABELS = {
    posts: 'ارسال پست',
    bots: 'ربات',
    schedules: 'زمان‌بندی',
    ai_monthly: 'هوش مصنوعی',
};
async function countRows(tenantId) {
    const db = (0, client_js_1.getDb)();
    const [c] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.channels).where((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId));
    const [b] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.bots).where((0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId));
    return { channels: Number(c?.value ?? 0), bots: Number(b?.value ?? 0) };
}
/**
 * Plan quota enforcement (§118). channels/bots count all tenant rows;
 * posts count non-draft rows since the subscription period start;
 * schedules count SCHEDULED posts; ai_monthly checks the current period.
 * A zero limit means unlimited only for posts and schedules; `ai_monthly = 0` means AI is unavailable.
 */
async function assertWithinLimit(tenantId, kind) {
    const ctx = await getPlanContext(tenantId);
    if (ctx.planCode === 'lifetime_admin')
        return;
    const db = (0, client_js_1.getDb)();
    if (kind === 'channels') {
        const { channels: used } = await countRows(tenantId);
        if (used >= ctx.limits.max_channels)
            throw new errors_js_1.AppError(errors_js_1.ERR.CHANNEL_LIMIT());
        return;
    }
    if (kind === 'bots') {
        const { bots: used } = await countRows(tenantId);
        if (used >= ctx.limits.max_bots)
            throw new errors_js_1.AppError(errors_js_1.ERR.QUOTA_EXCEEDED(QUOTA_LABELS.bots));
        return;
    }
    if (kind === 'posts') {
        if (ctx.limits.max_posts === 0)
            return; // unlimited
        const startedAt = ctx.startedAt;
        const conds = startedAt
            ? (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId), (0, drizzle_orm_1.ne)(schema_js_1.posts.state, 'DRAFT'), (0, drizzle_orm_1.ne)(schema_js_1.posts.state, 'CANCELLED'), (0, drizzle_orm_1.sql) `${schema_js_1.posts.createdAt} >= ${startedAt}`)
            : (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId), (0, drizzle_orm_1.ne)(schema_js_1.posts.state, 'DRAFT'), (0, drizzle_orm_1.ne)(schema_js_1.posts.state, 'CANCELLED'));
        const [row] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.posts).where(conds);
        if (Number(row?.value ?? 0) >= ctx.limits.max_posts) {
            throw new errors_js_1.AppError(errors_js_1.ERR.QUOTA_EXCEEDED(QUOTA_LABELS.posts));
        }
        return;
    }
    if (kind === 'schedules') {
        if (ctx.limits.max_schedules === 0)
            return; // unlimited
        const [row] = await db
            .select({ value: (0, drizzle_orm_1.count)() })
            .from(schema_js_1.posts)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.posts.state, 'SCHEDULED')));
        if (Number(row?.value ?? 0) >= ctx.limits.max_schedules) {
            throw new errors_js_1.AppError(errors_js_1.ERR.QUOTA_EXCEEDED(QUOTA_LABELS.schedules));
        }
        return;
    }
    // ai_monthly: 0 is a hard entitlement block, not unlimited.
    if (ctx.limits.ai_monthly === 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.PLAN_FEATURE_REQUIRED('هوش مصنوعی'));
    }
    const periodYm = new Date().toISOString().slice(0, 7);
    const [row] = await db
        .select({ requestCount: schema_js_1.aiUsageMonthly.requestCount })
        .from(schema_js_1.aiUsageMonthly)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.aiUsageMonthly.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.aiUsageMonthly.periodYm, periodYm)))
        .limit(1);
    if (Number(row?.requestCount ?? 0) >= ctx.limits.ai_monthly) {
        throw new errors_js_1.AppError(errors_js_1.ERR.QUOTA_EXCEEDED(QUOTA_LABELS.ai_monthly));
    }
}
/** Authoritative plan-feature guard used by every feature boundary. */
async function assertFeature(tenantId, feature) {
    const ctx = await getPlanContext(tenantId);
    if (ctx.planCode === 'lifetime_admin')
        return ctx;
    const features = (ctx.features ?? {});
    // Backward compatibility: subscriptions created before the separate campaign
    // entitlement existed inherit the previous WooCommerce permission only while
    // the new flag is absent. An explicit false set by an administrator is final.
    const legacyCampaignAccess = feature === 'wordpress_campaigns'
        && typeof features.wordpress_campaigns !== 'boolean'
        && features.woocommerce === true;
    const enabled = features[feature] === true || legacyCampaignAccess;
    if (!enabled) {
        const labels = {
            gold_ticker: 'ربات نرخ طلا و سکه',
            auto_responder: 'گردش‌کار و پاسخ‌گوی خودکار',
            woocommerce: 'اتصال وب‌سایت',
            wordpress_campaigns: 'کمپین‌های وب‌سایت',
            content_summarization: 'خلاصه‌سازی هوشمند محتوای سایت',
        };
        throw new errors_js_1.AppError(errors_js_1.ERR.PLAN_FEATURE_REQUIRED(labels[feature]));
    }
    return ctx;
}
/** Core activation logic — callable inside an existing transaction. */
async function activateSubscriptionTx(tx, tenantId, planId, months) {
    const [plan] = await tx.select().from(schema_js_1.plans).where((0, drizzle_orm_1.eq)(schema_js_1.plans.id, planId)).limit(1);
    if (!plan)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پلن'));
    // Serialize plan changes per tenant. This also establishes a shared lock
    // boundary with channel/bot/post quota-sensitive mutations.
    await tx.select({ id: schema_js_1.users.id }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, tenantId)).limit(1).for('update');
    const [active] = await tx
        .select()
        .from(schema_js_1.subscriptions)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.subscriptions.state, 'ACTIVE')))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.subscriptions.createdAt))
        .limit(1)
        .for('update');
    const now = new Date();
    const base = active && active.expiresAt.getTime() > now.getTime() ? active.expiresAt : now;
    const startedAt = new Date(base);
    const expiresAt = new Date(base.getTime() + months * plan.periodDays * 86400_000);
    const id = (0, ids_js_1.newId)();
    await tx.insert(schema_js_1.subscriptions).values({
        id,
        tenantId,
        planId,
        state: 'ACTIVE',
        startedAt,
        expiresAt,
    });
    return { subscriptionId: id, planCode: plan.code, startedAt, expiresAt, renewed: Boolean(active) };
}
/**
 * Activation state machine (§118): extension base = max(now, current ACTIVE
 * expiry); new ACTIVE row inserted; event + audit emitted.
 */
async function activateSubscription(tenantId, planId, months) {
    const db = (0, client_js_1.getDb)();
    const result = await db.transaction((tx) => activateSubscriptionTx(tx, tenantId, planId, months));
    await (0, events_js_1.emitEvent)({
        name: result.renewed ? 'subscription.renewed' : 'subscription.created',
        tenantId,
        subjectType: 'subscription',
        subjectId: result.subscriptionId,
        props: { planCode: result.planCode, months },
    });
    await (0, audit_js_1.audit)({
        action: 'subscription.activated',
        actorId: tenantId,
        subjectType: 'subscription',
        subjectId: result.subscriptionId,
        meta: { planCode: result.planCode, months, renewed: result.renewed },
    });
    return result;
}
/** ACTIVE + expired → EXPIRED, one event per row. Used by the scheduler. */
async function expireDueSubscriptions() {
    const db = (0, client_js_1.getDb)();
    const now = new Date();
    const due = await db
        .select({ id: schema_js_1.subscriptions.id, tenantId: schema_js_1.subscriptions.tenantId })
        .from(schema_js_1.subscriptions)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.state, 'ACTIVE'), (0, drizzle_orm_1.lt)(schema_js_1.subscriptions.expiresAt, now)))
        .limit(200);
    let expired = 0;
    for (const sub of due) {
        const res = await db
            .update(schema_js_1.subscriptions)
            .set({ state: 'EXPIRED' })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.id, sub.id), (0, drizzle_orm_1.eq)(schema_js_1.subscriptions.state, 'ACTIVE')));
        const changed = Array.isArray(res) ? Number(res[0]?.affectedRows ?? 0) : Number(res?.affectedRows ?? 0);
        if (changed > 0) {
            expired++;
            await (0, events_js_1.emitEvent)({
                name: 'subscription.expired',
                tenantId: sub.tenantId,
                subjectType: 'subscription',
                subjectId: sub.id,
            });
        }
    }
    return expired;
}
