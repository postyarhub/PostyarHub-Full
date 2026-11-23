"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAnalyticsRoutes = registerAnalyticsRoutes;
const zod_1 = require("zod");
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const analytics_service_js_1 = require("./analytics.service.js");
function requireTenant(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return req.user.id;
}
function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}
const eventsQuerySchema = zod_1.z.object({
    cursor: zod_1.z.string().min(10).max(26).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(50),
});
const dailyQuerySchema = zod_1.z.object({ days: zod_1.z.coerce.number().int().min(1).max(90).default(14) });
const daysQuerySchema = zod_1.z.object({ days: zod_1.z.coerce.number().int().min(1).max(90).default(30) });
const trackLinkSchema = zod_1.z.object({
    destinationUrl: zod_1.z.string().url().max(2000),
    postId: zod_1.z.string().max(26).nullable().optional(),
    targetId: zod_1.z.string().max(26).nullable().optional(),
    channelId: zod_1.z.string().max(26).nullable().optional(),
    campaignId: zod_1.z.string().max(26).nullable().optional(),
    source: zod_1.z.string().max(32).nullable().optional(),
});
async function registerAnalyticsRoutes(app) {
    app.get('/analytics/overview', { preHandler: [app.requireAuth] }, async (req) => {
        const tenantId = requireTenant(req);
        const db = (0, client_js_1.getDb)();
        const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000);
        const periodYm = new Date().toISOString().slice(0, 7);
        const [channelRows, botRows, postRows, sentRows, failedRows, walletRows, aiRows] = await Promise.all([
            db.select({ status: schema_js_1.channels.status, count: (0, drizzle_orm_1.sql) `count(*)` }).from(schema_js_1.channels).where((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId)).groupBy(schema_js_1.channels.status),
            db.select({ status: schema_js_1.bots.status, count: (0, drizzle_orm_1.sql) `count(*)` }).from(schema_js_1.bots).where((0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId)).groupBy(schema_js_1.bots.status),
            db.select({ state: schema_js_1.posts.state, count: (0, drizzle_orm_1.sql) `count(*)` }).from(schema_js_1.posts).where((0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId)).groupBy(schema_js_1.posts.state),
            db.select({ count: (0, drizzle_orm_1.sql) `count(*)` }).from(schema_js_1.postTargets).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'SENT'), (0, drizzle_orm_1.gte)(schema_js_1.postTargets.sentAt, since30d))),
            db.select({ count: (0, drizzle_orm_1.sql) `count(*)` }).from(schema_js_1.postTargets).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'FAILED'), (0, drizzle_orm_1.gte)(schema_js_1.postTargets.updatedAt, since30d))),
            db.select({ balanceRial: schema_js_1.walletAccounts.balanceRial }).from(schema_js_1.walletAccounts).where((0, drizzle_orm_1.eq)(schema_js_1.walletAccounts.tenantId, tenantId)).limit(1),
            db.select({ requestCount: schema_js_1.aiUsageMonthly.requestCount, tokenCount: schema_js_1.aiUsageMonthly.tokenCount }).from(schema_js_1.aiUsageMonthly).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.aiUsageMonthly.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.aiUsageMonthly.periodYm, periodYm))).limit(1),
        ]);
        let analytics = null;
        try {
            analytics = await (0, analytics_service_js_1.getTenantAnalytics)(tenantId, 30);
        }
        catch { /* legacy overview remains available */ }
        const countBy = (rows, value) => rows.filter((r) => (r.status ?? r.state) === value).reduce((acc, r) => acc + num(r.count), 0);
        return {
            success: true,
            data: {
                channels: { total: channelRows.reduce((acc, r) => acc + num(r.count), 0), active: countBy(channelRows, 'ACTIVE') },
                bots: { total: botRows.reduce((acc, r) => acc + num(r.count), 0), active: countBy(botRows, 'ACTIVE') },
                posts: { total: postRows.reduce((acc, r) => acc + num(r.count), 0), published: countBy(postRows, 'PUBLISHED') + countBy(postRows, 'PARTIAL') },
                deliveries: { sent30d: num(sentRows[0]?.count), failed30d: num(failedRows[0]?.count) },
                wallet: { balanceRial: num(walletRows[0]?.balanceRial ?? 0) },
                ai: { periodYm, requestCount: num(aiRows[0]?.requestCount ?? 0), tokenCount: num(aiRows[0]?.tokenCount ?? 0) },
                analytics,
            },
        };
    });
    app.get('/analytics/summary', { preHandler: [app.requireAuth] }, async (req) => {
        const tenantId = requireTenant(req);
        const query = daysQuerySchema.safeParse(req.query ?? {});
        if (!query.success)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('بازهٔ تحلیل معتبر نیست.'));
        return { success: true, data: await (0, analytics_service_js_1.getTenantAnalytics)(tenantId, query.data.days) };
    });
    app.get('/analytics/automation', { preHandler: [app.requireAuth] }, async (req) => {
        const tenantId = requireTenant(req);
        const query = daysQuerySchema.safeParse(req.query ?? {});
        if (!query.success)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('بازهٔ تحلیل معتبر نیست.'));
        const data = await (0, analytics_service_js_1.getTenantAnalytics)(tenantId, query.data.days);
        return { success: true, data: { days: data.days, automation: data.automation } };
    });
    app.get('/analytics/wordpress', { preHandler: [app.requireAuth] }, async (req) => {
        const tenantId = requireTenant(req);
        const query = daysQuerySchema.safeParse(req.query ?? {});
        if (!query.success)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('بازهٔ تحلیل معتبر نیست.'));
        return { success: true, data: await (0, analytics_service_js_1.getWordPressAnalytics)(tenantId, query.data.days) };
    });
    app.get('/analytics/revenue', { preHandler: [app.requireAuth] }, async (req) => {
        const tenantId = requireTenant(req);
        const query = daysQuerySchema.safeParse(req.query ?? {});
        if (!query.success)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('بازهٔ تحلیل معتبر نیست.'));
        const data = await (0, analytics_service_js_1.getTenantAnalytics)(tenantId, query.data.days);
        return { success: true, data: { days: data.days, revenue: data.revenue } };
    });
    app.get('/analytics/posts/:id', { preHandler: [app.requireAuth] }, async (req) => {
        const tenantId = requireTenant(req);
        const id = String(req.params.id ?? '');
        const query = daysQuerySchema.safeParse(req.query ?? {});
        if (!query.success)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('بازهٔ تحلیل معتبر نیست.'));
        return { success: true, data: await (0, analytics_service_js_1.getPostAnalytics)(tenantId, id, query.data.days) };
    });
    app.get('/analytics/campaigns/:id', { preHandler: [app.requireAuth] }, async (req) => {
        const tenantId = requireTenant(req);
        const id = String(req.params.id ?? '');
        const query = daysQuerySchema.safeParse(req.query ?? {});
        if (!query.success)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('بازهٔ تحلیل معتبر نیست.'));
        return { success: true, data: await (0, analytics_service_js_1.getCampaignAnalytics)(tenantId, id, query.data.days) };
    });
    app.get('/analytics/events', { preHandler: [app.requireAuth] }, async (req) => {
        const tenantId = requireTenant(req);
        const parsed = eventsQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('پارامترهای صفحه‌بندی معتبر نیست.'));
        const db = (0, client_js_1.getDb)();
        const conditions = [(0, drizzle_orm_1.eq)(schema_js_1.events.tenantId, tenantId)];
        if (parsed.data.cursor)
            conditions.push((0, drizzle_orm_1.lt)(schema_js_1.events.id, parsed.data.cursor));
        const rows = await db.select().from(schema_js_1.events).where((0, drizzle_orm_1.and)(...conditions)).orderBy((0, drizzle_orm_1.sql) `${schema_js_1.events.id} DESC`).limit(parsed.data.limit);
        return { success: true, data: { events: rows.map((e) => ({ id: e.id, name: e.name, subjectType: e.subjectType, subjectId: e.subjectId, props: e.propsJson, createdAt: e.createdAt })), nextCursor: rows.length === parsed.data.limit ? (rows[rows.length - 1]?.id ?? null) : null } };
    });
    // Same authenticated activity feed under an alternate path; keep /analytics/events for existing clients.
    app.get('/analytics/recent-activity', { preHandler: [app.requireAuth] }, async (req) => {
        const tenantId = requireTenant(req);
        const parsed = eventsQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('پارامترهای صفحه‌بندی معتبر نیست.'));
        const db = (0, client_js_1.getDb)();
        const conditions = [(0, drizzle_orm_1.eq)(schema_js_1.events.tenantId, tenantId)];
        if (parsed.data.cursor)
            conditions.push((0, drizzle_orm_1.lt)(schema_js_1.events.id, parsed.data.cursor));
        // The activity UI needs only identifiers, labels, and timestamps; omit stored event props.
        const rows = await db.select({ id: schema_js_1.events.id, name: schema_js_1.events.name, subjectType: schema_js_1.events.subjectType, subjectId: schema_js_1.events.subjectId, createdAt: schema_js_1.events.createdAt }).from(schema_js_1.events).where((0, drizzle_orm_1.and)(...conditions)).orderBy((0, drizzle_orm_1.sql) `${schema_js_1.events.id} DESC`).limit(parsed.data.limit);
        return { success: true, data: { events: rows, nextCursor: rows.length === parsed.data.limit ? (rows[rows.length - 1]?.id ?? null) : null } };
    });
    app.get('/analytics/daily', { preHandler: [app.requireAuth] }, async (req) => {
        const tenantId = requireTenant(req);
        const parsed = dailyQuerySchema.safeParse(req.query ?? {});
        if (!parsed.success)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('پارامتر بازهٔ زمانی معتبر نیست.'));
        const analytics = await (0, analytics_service_js_1.getTenantAnalytics)(tenantId, parsed.data.days);
        return { success: true, data: { days: parsed.data.days, series: analytics.daily, summary: analytics } };
    });
    app.post('/analytics/links', { preHandler: [app.requireAuth] }, async (req) => {
        const tenantId = requireTenant(req);
        const parsed = trackLinkSchema.safeParse(req.body ?? {});
        if (!parsed.success)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('اطلاعات لینک معتبر نیست.'));
        try {
            return { success: true, data: await (0, analytics_service_js_1.createTrackedLink)({ userId: tenantId, ...parsed.data }) };
        }
        catch {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('آدرس مقصد معتبر نیست.'));
        }
    });
    app.get('/analytics/links/:id', { preHandler: [app.requireAuth] }, async (req) => {
        const tenantId = requireTenant(req);
        const id = String(req.params.id ?? '');
        const data = await (0, analytics_service_js_1.getLinkStats)(tenantId, id);
        if (!data)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('لینک تحلیلی'));
        return { success: true, data };
    });
    app.get('/r/:token', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
        const token = String(req.params.token ?? '');
        const link = await (0, analytics_service_js_1.resolveTrackedLink)(token);
        if (!link)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('لینک'));
        const q = (req.query ?? {});
        await (0, analytics_service_js_1.recordTrackedLinkClick)(link, {
            platform: typeof q.platform === 'string' ? q.platform : null,
            source: typeof q.source === 'string' ? q.source : null,
            referrer: req.headers.referer ?? null,
            userAgent: req.headers['user-agent'] ?? null,
            ip: req.ip,
        });
        return reply.redirect(link.destinationUrl);
    });
    app.get('/admin/analytics/overview', { preHandler: [app.requirePermission('admin.access')] }, async (req) => {
        const query = daysQuerySchema.safeParse(req.query ?? {});
        if (!query.success)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('بازهٔ تحلیل معتبر نیست.'));
        return { success: true, data: await (0, analytics_service_js_1.getAdminAnalytics)(query.data.days) };
    });
}
