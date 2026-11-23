"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFeedbackRoutes = registerFeedbackRoutes;
const ulid_1 = require("ulid");
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const idSchema = zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
const submitSchema = zod_1.z.object({
    displayName: zod_1.z.string().trim().min(2).max(80),
    message: zod_1.z.string().trim().min(30).max(2000),
    showOnHomepage: zod_1.z.boolean(),
});
const reviewSchema = zod_1.z.object({ note: zod_1.z.string().trim().max(500).optional().default('') });
function sendError(reply, statusCode, code, message) {
    return reply.code(statusCode).send({ success: false, error: { code, message } });
}
function isSuperAdmin(req) {
    return req.user?.role === 'SUPER_ADMIN';
}
function newId() { return (0, ulid_1.ulid)(); }
function statusLabel(status) {
    return ({ PENDING: 'در انتظار بررسی', APPROVED: 'تأیید شده', REJECTED: 'رد شده', CLOSED: 'از نمایش خارج شده' })[status];
}
async function registerFeedbackRoutes(app) {
    // Only feedback with explicit display consent and administrator approval can appear publicly.
    app.get('/feedback/public', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_req, reply) => {
        const rows = await (0, client_js_1.getDb)().select({
            id: schema_js_1.userFeedback.id,
            displayName: schema_js_1.userFeedback.displayName,
            message: schema_js_1.userFeedback.message,
            createdAt: schema_js_1.userFeedback.createdAt,
        }).from(schema_js_1.userFeedback)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.userFeedback.status, 'APPROVED'), (0, drizzle_orm_1.eq)(schema_js_1.userFeedback.showOnHomepage, 1)))
            .orderBy((0, drizzle_orm_1.desc)(schema_js_1.userFeedback.updatedAt), (0, drizzle_orm_1.desc)(schema_js_1.userFeedback.createdAt)).limit(6);
        reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
        return { success: true, data: { items: rows } };
    });
    app.get('/feedback/mine', { preHandler: [app.requireAuth] }, async (req, reply) => {
        if (!req.user)
            return sendError(reply, 401, 'AUTH_REQUIRED', 'برای مشاهدهٔ نظرات ثبت‌شده وارد حساب شوید.');
        const rows = await (0, client_js_1.getDb)().select({
            id: schema_js_1.userFeedback.id,
            displayName: schema_js_1.userFeedback.displayName,
            message: schema_js_1.userFeedback.message,
            showOnHomepage: schema_js_1.userFeedback.showOnHomepage,
            status: schema_js_1.userFeedback.status,
            reviewNote: schema_js_1.userFeedback.reviewNote,
            createdAt: schema_js_1.userFeedback.createdAt,
            updatedAt: schema_js_1.userFeedback.updatedAt,
        }).from(schema_js_1.userFeedback).where((0, drizzle_orm_1.eq)(schema_js_1.userFeedback.userId, req.user.id))
            .orderBy((0, drizzle_orm_1.desc)(schema_js_1.userFeedback.createdAt)).limit(50);
        return { success: true, data: { items: rows.map((item) => ({ ...item, statusLabel: statusLabel(item.status) })) } };
    });
    app.post('/feedback', { preHandler: [app.requireAuth], config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
        if (!req.user)
            return sendError(reply, 401, 'AUTH_REQUIRED', 'برای ثبت نظر وارد حساب شوید.');
        const parsed = submitSchema.safeParse(req.body);
        if (!parsed.success)
            return sendError(reply, 400, 'VALIDATION_ERROR', 'نام نمایشی معتبر و متن نظر بین ۳۰ تا ۲۰۰۰ نویسه لازم است.');
        const db = (0, client_js_1.getDb)();
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recent = await db.select({ total: (0, drizzle_orm_1.count)() }).from(schema_js_1.userFeedback)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.userFeedback.userId, req.user.id), (0, drizzle_orm_1.gte)(schema_js_1.userFeedback.createdAt, since)));
        if (Number(recent[0]?.total ?? 0) >= 3)
            return sendError(reply, 429, 'FEEDBACK_DAILY_LIMIT', 'حداکثر ۳ نظر در هر ۲۴ ساعت مجاز است.');
        const id = newId();
        await db.insert(schema_js_1.userFeedback).values({
            id,
            userId: req.user.id,
            displayName: parsed.data.displayName,
            message: parsed.data.message,
            showOnHomepage: parsed.data.showOnHomepage ? 1 : 0,
            status: 'PENDING',
            reviewedBy: null,
            reviewedAt: null,
            reviewNote: null,
        });
        reply.code(201);
        return { success: true, data: { id, status: 'PENDING', message: 'نظر شما برای بررسی مدیر ثبت شد.' } };
    });
    app.get('/feedback/admin', { preHandler: [app.requireAuth] }, async (req, reply) => {
        if (!isSuperAdmin(req))
            return sendError(reply, 403, 'FORBIDDEN', 'دسترسی مدیر ارشد لازم است.');
        const db = (0, client_js_1.getDb)();
        const rows = await db.select({
            id: schema_js_1.userFeedback.id,
            userId: schema_js_1.userFeedback.userId,
            displayName: schema_js_1.userFeedback.displayName,
            message: schema_js_1.userFeedback.message,
            showOnHomepage: schema_js_1.userFeedback.showOnHomepage,
            status: schema_js_1.userFeedback.status,
            reviewedBy: schema_js_1.userFeedback.reviewedBy,
            reviewedAt: schema_js_1.userFeedback.reviewedAt,
            reviewNote: schema_js_1.userFeedback.reviewNote,
            createdAt: schema_js_1.userFeedback.createdAt,
            updatedAt: schema_js_1.userFeedback.updatedAt,
        }).from(schema_js_1.userFeedback).orderBy((0, drizzle_orm_1.desc)(schema_js_1.userFeedback.createdAt)).limit(500);
        const grouped = await db.select({ status: schema_js_1.userFeedback.status, total: (0, drizzle_orm_1.count)() })
            .from(schema_js_1.userFeedback).groupBy(schema_js_1.userFeedback.status);
        const stats = { total: 0, pending: 0, approved: 0, rejected: 0, closed: 0, public: 0 };
        for (const item of grouped) {
            const n = Number(item.total ?? 0);
            stats.total += n;
            if (item.status === 'PENDING')
                stats.pending = n;
            else if (item.status === 'APPROVED')
                stats.approved = n;
            else if (item.status === 'REJECTED')
                stats.rejected = n;
            else if (item.status === 'CLOSED')
                stats.closed = n;
        }
        const publicCount = await db.select({ total: (0, drizzle_orm_1.count)() }).from(schema_js_1.userFeedback)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.userFeedback.status, 'APPROVED'), (0, drizzle_orm_1.eq)(schema_js_1.userFeedback.showOnHomepage, 1)));
        stats.public = Number(publicCount[0]?.total ?? 0);
        return { success: true, data: { items: rows, stats } };
    });
    const review = async (req, reply, action) => {
        if (!isSuperAdmin(req) || !req.user)
            return sendError(reply, 403, 'FORBIDDEN', 'دسترسی مدیر ارشد لازم است.');
        const params = req.params;
        const parsedId = idSchema.safeParse(params.id);
        const parsedBody = action === 'REJECTED' ? reviewSchema.safeParse(req.body ?? {}) : reviewSchema.safeParse(req.body ?? {});
        if (!parsedId.success || !parsedBody.success)
            return sendError(reply, 400, 'VALIDATION_ERROR', 'اطلاعات بررسی نظر معتبر نیست.');
        const current = await (0, client_js_1.getDb)().select({ id: schema_js_1.userFeedback.id }).from(schema_js_1.userFeedback)
            .where((0, drizzle_orm_1.eq)(schema_js_1.userFeedback.id, parsedId.data)).limit(1);
        if (!current.length)
            return sendError(reply, 404, 'FEEDBACK_NOT_FOUND', 'نظر پیدا نشد.');
        await (0, client_js_1.getDb)().update(schema_js_1.userFeedback).set({
            status: action,
            reviewedBy: req.user.id,
            reviewedAt: new Date(),
            reviewNote: parsedBody.data.note || null,
            updatedAt: new Date(),
        }).where((0, drizzle_orm_1.eq)(schema_js_1.userFeedback.id, parsedId.data));
        return { success: true, data: { id: parsedId.data, status: action } };
    };
    app.post('/feedback/admin/:id/approve', { preHandler: [app.requireAuth] }, (req, reply) => review(req, reply, 'APPROVED'));
    app.post('/feedback/admin/:id/reject', { preHandler: [app.requireAuth] }, (req, reply) => review(req, reply, 'REJECTED'));
    app.post('/feedback/admin/:id/hide', { preHandler: [app.requireAuth] }, (req, reply) => review(req, reply, 'CLOSED'));
}
