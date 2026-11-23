"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPostRoutes = registerPostRoutes;
const zod_1 = require("zod");
const errors_js_1 = require("../../core/errors.js");
const validation_js_1 = require("../../core/validation.js");
const button_target_js_1 = require("../../core/button-target.js");
const post_service_js_1 = require("./post.service.js");
function actor(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return { tenantId: req.user.id, actorId: req.user.id, actorRole: req.user.role, ip: req.ip };
}
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
const buttonUrlSchema = zod_1.z.string().trim().min(1).max(255).transform((value, ctx) => {
    try {
        return (0, button_target_js_1.normalizeButtonTargetValue)('URL', value);
    }
    catch {
        ctx.addIssue({ code: zod_1.z.ZodIssueCode.custom, message: 'آدرس دکمه باید یک لینک معتبر http یا https باشد.' });
        return zod_1.z.NEVER;
    }
});
const buttonIdSchema = (type) => zod_1.z.string().trim().min(1).max(190).transform((value, ctx) => {
    try {
        return (0, button_target_js_1.normalizeButtonTargetValue)(type, value);
    }
    catch {
        ctx.addIssue({ code: zod_1.z.ZodIssueCode.custom, message: 'شناسهٔ واردشده معتبر نیست.' });
        return zod_1.z.NEVER;
    }
});
const buttonPhoneSchema = zod_1.z.string().trim().min(1).max(32).transform((value, ctx) => {
    try {
        return (0, button_target_js_1.normalizeButtonTargetValue)('PHONE', value);
    }
    catch {
        ctx.addIssue({ code: zod_1.z.ZodIssueCode.custom, message: 'شمارهٔ تلفن واردشده معتبر نیست.' });
        return zod_1.z.NEVER;
    }
});
const buttonLegacyUsernameSchema = zod_1.z.string().trim().regex(/^@?[A-Za-z0-9_\u200c\u0600-\u06ff.]{2,190}$/);
const buttonTargetSchema = zod_1.z.discriminatedUnion('type', [
    zod_1.z.object({ type: zod_1.z.literal('URL'), value: buttonUrlSchema }),
    zod_1.z.object({ type: zod_1.z.literal('PHONE'), value: buttonPhoneSchema }),
    zod_1.z.object({ type: zod_1.z.literal('TELEGRAM_ID'), value: buttonIdSchema('TELEGRAM_ID') }),
    zod_1.z.object({ type: zod_1.z.literal('BALE_ID'), value: buttonIdSchema('BALE_ID') }),
    zod_1.z.object({ type: zod_1.z.literal('RUBIKA_ID'), value: buttonIdSchema('RUBIKA_ID') }),
    // Legacy rows remain accepted and are normalized by the delivery worker.
    zod_1.z.object({ type: zod_1.z.literal('USERNAME'), value: buttonLegacyUsernameSchema }),
]);
const buttonItemSchema = zod_1.z.object({
    label: zod_1.z.string().min(1).max(64),
    target: buttonTargetSchema.optional(),
    url: buttonUrlSchema.optional(),
    callback: zod_1.z.string().max(64).optional(),
});
const buttonsSchema = zod_1.z.object({
    byChannel: zod_1.z.record(zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/), zod_1.z.array(buttonItemSchema).max(8)).optional().refine((value) => !value || Object.keys(value).length <= 20, { message: 'حداکثر ۲۰ کانال مجاز است.' }),
    footerByChannel: zod_1.z.record(zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/), zod_1.z.string().trim().max(500)).optional().refine((value) => !value || Object.keys(value).length <= 20, { message: 'حداکثر ۲۰ کانال مجاز است.' }),
    byPlatform: zod_1.z
        .object({
        telegram: zod_1.z.array(buttonItemSchema).max(8).optional(),
        bale: zod_1.z.array(buttonItemSchema).max(8).optional(),
        rubika: zod_1.z.array(buttonItemSchema).max(8).optional(),
    })
        .optional(),
    // Legacy shapes remain accepted so existing drafts/posts are not broken.
    inline: zod_1.z.array(buttonItemSchema).max(8).optional(),
    links: zod_1.z
        .array(zod_1.z.object({ label: zod_1.z.string().min(1).max(64), url: buttonUrlSchema }))
        .max(8)
        .optional(),
});
const createPostSchema = zod_1.z.object({
    title: zod_1.z.string().max(190).optional(),
    body: zod_1.z.string().max(4000).optional(),
    parseMode: zod_1.z.enum(['NONE', 'HTML', 'MARKDOWN']).optional(),
    mediaId: zod_1.z.string().min(10).max(26).optional(),
    mediaIds: zod_1.z.array(zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/)).max(10).optional(),
    buttons: buttonsSchema.optional(),
});
const publishSchema = zod_1.z.object({ channelIds: zod_1.z.array(zod_1.z.string().min(10).max(26)).min(1).max(20) });
const scheduleSchema = publishSchema.extend({
    scheduledAt: zod_1.z.coerce.date(),
});
const updateScheduledPostSchema = zod_1.z.object({
    title: zod_1.z.string().max(190).nullable().optional(),
    body: zod_1.z.string().max(4000),
    parseMode: zod_1.z.enum(['NONE', 'HTML', 'MARKDOWN']).optional(),
    mediaId: zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/).nullable(),
    mediaIds: zod_1.z.array(zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/)).max(10).optional(),
    buttons: buttonsSchema.nullable(),
    channelIds: zod_1.z.array(zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/)).min(1).max(20),
    scheduledAt: zod_1.z.coerce.date(),
});
const listQuerySchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    pageSize: zod_1.z.coerce.number().int().min(1).max(100).default(20),
    state: zod_1.z
        .enum(['DRAFT', 'SCHEDULED', 'QUEUED', 'PUBLISHING', 'PUBLISHED', 'PARTIAL', 'FAILED', 'CANCELLED'])
        .optional(),
    search: zod_1.z.string().max(100).optional(),
    channelId: zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/).optional(),
});
async function registerPostRoutes(app) {
    // Public phone bridge for providers whose inline URL contract only permits
    // HTTP(S). It validates the canonical phone representation and redirects
    // only to the tel: URI chosen by the user.
    app.get('/public/phone/:number', async (req, reply) => {
        const number = req.params.number;
        if (typeof number !== 'string')
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('لینک'));
        let phone;
        try {
            phone = (0, button_target_js_1.normalizeButtonTargetValue)('PHONE', decodeURIComponent(number));
        }
        catch {
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('لینک'));
        }
        void reply.code(302);
        void reply.header('location', `tel:${phone}`);
        void reply.header('cache-control', 'no-store');
        void reply.header('referrer-policy', 'no-referrer');
        return reply.send();
    });
    app.post('/posts', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId, ...meta } = actor(req);
        const input = parse(createPostSchema, req.body);
        const post = await (0, post_service_js_1.createPost)(tenantId, input, meta);
        return { success: true, data: { post } };
    });
    app.post('/posts/:id/publish', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId, ...meta } = actor(req);
        const { id } = req.params;
        const input = parse(publishSchema, req.body);
        const post = await (0, post_service_js_1.publishNow)(tenantId, id, input.channelIds, meta);
        return { success: true, data: { post } };
    });
    app.post('/posts/:id/schedule', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId, ...meta } = actor(req);
        const { id } = req.params;
        const input = parse(scheduleSchema, req.body);
        const post = await (0, post_service_js_1.schedulePost)(tenantId, id, input.channelIds, input.scheduledAt, meta);
        return { success: true, data: { post } };
    });
    app.put('/posts/:id/schedule', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId, ...meta } = actor(req);
        const { id } = req.params;
        const input = parse(updateScheduledPostSchema, req.body);
        const post = await (0, post_service_js_1.updateScheduledPost)(tenantId, id, input, meta);
        return { success: true, data: { post } };
    });
    app.get('/posts', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const query = parse(listQuerySchema, req.query);
        const result = await (0, post_service_js_1.listPosts)(tenantId, {
            page: query.page,
            pageSize: query.pageSize,
            state: query.state,
            search: query.search,
            channelId: query.channelId,
        });
        return { success: true, data: result };
    });
    app.get('/posts/:id', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const { id } = req.params;
        const result = await (0, post_service_js_1.getPost)(tenantId, id);
        return { success: true, data: result };
    });
    app.post('/posts/:id/cancel', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId, ...meta } = actor(req);
        const { id } = req.params;
        const post = await (0, post_service_js_1.cancelPost)(tenantId, id, meta);
        return { success: true, data: { post } };
    });
    app.post('/posts/targets/:targetId/retry', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId, ...meta } = actor(req);
        const { targetId } = req.params;
        const result = await (0, post_service_js_1.retryTarget)(tenantId, targetId, meta);
        return { success: true, data: result };
    });
    const deleteSingleHandler = async (req) => {
        const { tenantId, ...meta } = actor(req);
        const { id } = req.params;
        const result = await (0, post_service_js_1.deletePost)(tenantId, id, meta);
        return { success: true, data: result };
    };
    app.delete('/posts/:id', { preHandler: [app.requireAuth] }, deleteSingleHandler);
    app.post('/posts/:id/delete', { preHandler: [app.requireAuth] }, deleteSingleHandler);
    const bulkDeleteHandler = async (req) => {
        const { tenantId, ...meta } = actor(req);
        const schema = zod_1.z.object({
            ids: zod_1.z.array(zod_1.z.string().min(1)).optional(),
            state: zod_1.z.string().optional(),
            olderThanDays: zod_1.z.number().int().positive().optional(),
        });
        const input = parse(schema, req.body ?? {});
        const result = await (0, post_service_js_1.deletePostsBulk)(tenantId, {
            ids: input.ids,
            state: input.state,
            olderThanDays: input.olderThanDays,
        }, meta);
        return { success: true, data: result };
    };
    app.post('/posts/delete-bulk', { preHandler: [app.requireAuth] }, bulkDeleteHandler);
    app.post('/posts/bulk-delete', { preHandler: [app.requireAuth] }, bulkDeleteHandler);
}
