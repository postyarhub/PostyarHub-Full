"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSubscriptionRoutes = registerSubscriptionRoutes;
const zod_1 = require("zod");
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const drizzle_orm_2 = require("drizzle-orm");
const plan_service_js_1 = require("./plan.service.js");
const payment_service_js_1 = require("../payments/payment.service.js");
const validation_js_1 = require("../../core/validation.js");
function auth(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return { id: req.user.id, role: req.user.role };
}
const checkoutSchema = zod_1.z.object({
    planCode: zod_1.z.string().min(1).max(40),
    months: zod_1.z.coerce.number().int().min(1).max(12),
});
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
async function registerSubscriptionRoutes(app) {
    // Public: plan catalog with Persian names (landing + dashboard)
    app.get('/subscriptions/plans', async () => {
        const db = (0, client_js_1.getDb)();
        const rows = await db
            .select({
            id: schema_js_1.plans.id,
            code: schema_js_1.plans.code,
            nameFa: schema_js_1.plans.nameFa,
            priceRial: schema_js_1.plans.priceRial,
            periodDays: schema_js_1.plans.periodDays,
            limitsJson: schema_js_1.plans.limitsJson,
            featuresJson: schema_js_1.plans.featuresJson,
            pricingJson: schema_js_1.plans.pricingJson,
            sortOrder: schema_js_1.plans.sortOrder,
        })
            .from(schema_js_1.plans)
            .where((0, drizzle_orm_1.eq)(schema_js_1.plans.isActive, 1))
            .orderBy((0, drizzle_orm_1.asc)(schema_js_1.plans.sortOrder));
        return {
            success: true,
            data: {
                plans: rows.map((row) => ({ ...row, featuresJson: (0, plan_service_js_1.normalizePlanFeatures)(row.featuresJson) })),
            },
        };
    });
    // Contract 14-contract item 6: current subscription + plan + server-computed
    // usage for the (re)built Subscription page.
    //   postsSent      → DISTINCT posts with ≥1 SENT delivery (post_targets
    //                    state='SENT', sent_at within the subscription period;
    //                    all-time when no subscription). "Delivered posts" — the
    //                    countable, honest state, unlike created-post counts.
    //   botsActive / channelsActive → tenant row counts. The schema has no
    //                    soft-delete marker (disconnect = status DISABLED, row
    //                    kept), matching §118 quota counting in plan.service.
    //   daysRemaining  → ceil((expiresAt − now)/day), 0 without a subscription.
    //   limits         → plan.limitsJson (max_posts / max_bots / max_channels);
    //                    0 means unlimited (documented product semantics).
    app.get('/subscriptions/current', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const tenantId = me.id;
        const ctx = await (0, plan_service_js_1.getPlanContext)(tenantId);
        const db = (0, client_js_1.getDb)();
        const [planRow] = await db
            .select({ priceRial: schema_js_1.plans.priceRial, periodDays: schema_js_1.plans.periodDays })
            .from(schema_js_1.plans)
            .where((0, drizzle_orm_1.eq)(schema_js_1.plans.id, ctx.planId))
            .limit(1);
        const sentConds = ctx.startedAt
            ? (0, drizzle_orm_2.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'SENT'), (0, drizzle_orm_1.gte)(schema_js_1.postTargets.sentAt, ctx.startedAt))
            : (0, drizzle_orm_2.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'SENT'));
        const [postsRow] = await db
            .select({ value: (0, drizzle_orm_1.countDistinct)(schema_js_1.postTargets.postId) })
            .from(schema_js_1.postTargets)
            .where(sentConds);
        const [channelsRow] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.channels).where((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId));
        const [botsRow] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.bots).where((0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId));
        const daysRemaining = ctx.expiresAt
            ? Math.max(0, Math.ceil((ctx.expiresAt.getTime() - Date.now()) / 86_400_000))
            : 0;
        return {
            success: true,
            data: {
                subscription: ctx.subscriptionId && ctx.state === 'ACTIVE'
                    ? { id: ctx.subscriptionId, state: ctx.state, startedAt: ctx.startedAt, expiresAt: ctx.expiresAt }
                    : null,
                plan: {
                    id: ctx.planId,
                    code: ctx.planCode,
                    nameFa: ctx.planNameFa,
                    priceRial: Number(planRow?.priceRial ?? 0),
                    periodDays: Number(planRow?.periodDays ?? 30),
                    limits: ctx.limits,
                    features: ctx.features,
                },
                usage: {
                    daysRemaining,
                    postsSent: Number(postsRow?.value ?? 0),
                    botsActive: Number(botsRow?.value ?? 0),
                    channelsActive: Number(channelsRow?.value ?? 0),
                    limits: {
                        postsPerMonth: ctx.limits.max_posts,
                        bots: ctx.limits.max_bots,
                        channels: ctx.limits.max_channels,
                    },
                },
            },
        };
    });
    // Current subscription + plan + limits + live usage summary
    app.get('/subscriptions/me', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const tenantId = me.id;
        const ctx = await (0, plan_service_js_1.getPlanContext)(tenantId);
        const db = (0, client_js_1.getDb)();
        const startedAt = ctx.startedAt;
        const postConds = startedAt
            ? (0, drizzle_orm_2.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId), (0, drizzle_orm_2.ne)(schema_js_1.posts.state, 'DRAFT'), (0, drizzle_orm_2.ne)(schema_js_1.posts.state, 'CANCELLED'), (0, drizzle_orm_2.sql) `${schema_js_1.posts.createdAt} >= ${startedAt}`)
            : (0, drizzle_orm_2.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId), (0, drizzle_orm_2.ne)(schema_js_1.posts.state, 'DRAFT'), (0, drizzle_orm_2.ne)(schema_js_1.posts.state, 'CANCELLED'));
        const [channelsRow] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.channels).where((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId));
        const [botsRow] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.bots).where((0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId));
        const [postsRow] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.posts).where(postConds);
        const [schedRow] = await db
            .select({ value: (0, drizzle_orm_1.count)() })
            .from(schema_js_1.posts)
            .where((0, drizzle_orm_2.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.posts.state, 'SCHEDULED')));
        const periodYm = new Date().toISOString().slice(0, 7);
        const [aiRow] = await db
            .select({ requestCount: schema_js_1.aiUsageMonthly.requestCount })
            .from(schema_js_1.aiUsageMonthly)
            .where((0, drizzle_orm_2.and)((0, drizzle_orm_1.eq)(schema_js_1.aiUsageMonthly.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.aiUsageMonthly.periodYm, periodYm)))
            .limit(1);
        return {
            success: true,
            data: {
                subscription: {
                    id: ctx.subscriptionId,
                    state: ctx.state,
                    startedAt: ctx.startedAt,
                    expiresAt: ctx.expiresAt,
                },
                plan: {
                    id: ctx.planId,
                    code: ctx.planCode,
                    nameFa: ctx.planNameFa,
                    limits: ctx.limits,
                    features: ctx.features,
                },
                usage: {
                    channels: Number(channelsRow?.value ?? 0),
                    bots: Number(botsRow?.value ?? 0),
                    postsThisPeriod: Number(postsRow?.value ?? 0),
                    scheduled: Number(schedRow?.value ?? 0),
                    aiRequestsThisMonth: Number(aiRow?.requestCount ?? 0),
                },
            },
        };
    });
    // Checkout: create a gateway payment and return the redirect URL
    app.post('/subscriptions/checkout', { preHandler: [app.requireAuth] }, async (req) => {
        const input = parse(checkoutSchema, req.body);
        const result = await (0, payment_service_js_1.createSubscriptionPayment)(auth(req).id, input.planCode, input.months);
        return { success: true, data: result };
    });
}
