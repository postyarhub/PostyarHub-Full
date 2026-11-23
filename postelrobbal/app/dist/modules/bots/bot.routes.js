"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerBotRoutes = registerBotRoutes;
const webhook_rate_limit_js_1 = require("./webhook-rate-limit.js");
const zod_1 = require("zod");
const errors_js_1 = require("../../core/errors.js");
const validation_js_1 = require("../../core/validation.js");
const button_target_js_1 = require("../../core/button-target.js");
const bot_service_js_1 = require("./bot.service.js");
const bot_users_export_js_1 = require("./bot-users-export.js");
const ulidish = zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/, 'شناسه معتبر نیست.');
const connectSchema = zod_1.z.object({
    platform: zod_1.z.enum(['telegram', 'bale', 'rubika']),
    token: zod_1.z.string().min(10).max(256),
    title: zod_1.z.string().min(1).max(190).optional(),
});
const modeSchema = zod_1.z.object({ mode: zod_1.z.enum(['WEBHOOK', 'POLLING']) });
const aiSettingsSchema = zod_1.z.object({
    aiEnabled: zod_1.z.boolean(),
    aiSystemPrompt: zod_1.z.string().max(4000).nullable().optional(),
});
const paginationQuery = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    pageSize: zod_1.z.coerce.number().int().min(1).max(100).default(20),
});
const conversationQuery = paginationQuery.extend({
    platformUserId: zod_1.z.string().max(190).optional(),
});
const botButtonUrlSchema = zod_1.z.string().trim().min(1).max(255).transform((value, ctx) => {
    try {
        return (0, button_target_js_1.normalizeButtonTargetValue)('URL', value);
    }
    catch {
        ctx.addIssue({ code: zod_1.z.ZodIssueCode.custom, message: 'نشانی دکمه باید یک لینک معتبر HTTP یا HTTPS باشد.' });
        return zod_1.z.NEVER;
    }
});
const responsePayloadSchema = zod_1.z
    .object({
    text: zod_1.z.string().max(4000).optional(),
    buttons: zod_1.z
        .array(zod_1.z.object({
        label: zod_1.z.string().min(1).max(64),
        url: botButtonUrlSchema.optional(),
        callback: zod_1.z.string().max(64).optional(),
    }))
        .max(8)
        .optional(),
    systemPrompt: zod_1.z.string().max(4000).optional(),
    workflowId: ulidish.optional(),
})
    .strict();
const commandCreateSchema = zod_1.z.object({
    command: zod_1.z.string().min(2).max(64),
    descriptionFa: zod_1.z.string().max(190).optional(),
    responseKind: zod_1.z.enum(['TEXT', 'BUTTONS', 'AI', 'WORKFLOW']).default('TEXT'),
    responsePayload: responsePayloadSchema.nullable().optional(),
});
const commandUpdateSchema = zod_1.z.object({
    command: zod_1.z.string().min(2).max(64).optional(),
    descriptionFa: zod_1.z.string().max(190).optional(),
    responseKind: zod_1.z.enum(['TEXT', 'BUTTONS', 'AI', 'WORKFLOW']).optional(),
    responsePayload: responsePayloadSchema.nullable().optional(),
    isEnabled: zod_1.z.boolean().optional(),
});
const keywordCreateSchema = zod_1.z.object({
    keyword: zod_1.z.string().min(2).max(190),
    matchKind: zod_1.z.enum(['EXACT', 'CONTAINS']).default('CONTAINS'),
    responseKind: zod_1.z.enum(['TEXT', 'BUTTONS', 'AI', 'WORKFLOW']).default('TEXT'),
    responsePayload: responsePayloadSchema.nullable().optional(),
});
const keywordUpdateSchema = zod_1.z.object({
    keyword: zod_1.z.string().min(2).max(190).optional(),
    matchKind: zod_1.z.enum(['EXACT', 'CONTAINS']).optional(),
    responseKind: zod_1.z.enum(['TEXT', 'BUTTONS', 'AI', 'WORKFLOW']).optional(),
    responsePayload: responsePayloadSchema.nullable().optional(),
    isEnabled: zod_1.z.boolean().optional(),
});
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
function parseParam(schema, value) {
    return parse(schema, value);
}
function asPayload(v) {
    if (!v)
        return null;
    return {
        ...(v.text !== undefined ? { text: v.text } : {}),
        ...(v.buttons !== undefined ? { buttons: v.buttons } : {}),
        ...(v.systemPrompt !== undefined ? { systemPrompt: v.systemPrompt } : {}),
        ...(v.workflowId !== undefined ? { workflowId: v.workflowId } : {}),
    };
}
async function registerBotRoutes(app) {
    // ---- bots CRUD-ish lifecycle ----
    app.post('/bots', {
        preHandler: app.requireAuth,
        config: { rateLimit: { max: 10, timeWindow: '1 hour', keyGenerator: (req) => req.user?.id ?? req.ip } },
    }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const input = parse(connectSchema, req.body);
        const bot = await (0, bot_service_js_1.connectBot)(user.id, input);
        return { success: true, data: { bot } };
    });
    app.get('/bots', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const items = await (0, bot_service_js_1.listBots)(user.id);
        return { success: true, data: { items } };
    });
    app.post('/bots/:id/verify', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const result = await (0, bot_service_js_1.verifyBot)(user.id, id);
        return { success: true, data: result };
    });
    app.post('/bots/:id/enable', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const bot = await (0, bot_service_js_1.enableBot)(user.id, id);
        return { success: true, data: { bot } };
    });
    app.post('/bots/:id/disable', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const bot = await (0, bot_service_js_1.disableBot)(user.id, id);
        return { success: true, data: { bot } };
    });
    app.post('/bots/:id/mode', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const { mode } = parse(modeSchema, req.body);
        const bot = await (0, bot_service_js_1.setBotMode)(user.id, id, mode);
        return { success: true, data: { bot } };
    });
    app.put('/bots/:id/ai', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const input = parse(aiSettingsSchema, req.body);
        const bot = await (0, bot_service_js_1.updateAiSettings)(user.id, id, input);
        return { success: true, data: { bot } };
    });
    app.get('/bots/:id/users', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const q = parse(paginationQuery, req.query);
        const result = await (0, bot_service_js_1.listBotUsers)(user.id, id, q.page, q.pageSize);
        return { success: true, data: result };
    });
    app.get('/bots/:id/users/export', { preHandler: app.requireAuth }, async (req, reply) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const rows = await (0, bot_service_js_1.exportBotUsers)(user.id, id);
        const csv = (0, bot_users_export_js_1.buildBotUsersCsv)(rows);
        return reply
            .header('content-type', 'text/csv; charset=utf-8')
            .header('content-disposition', `attachment; filename="postyar-bot-users-${id}.csv"`)
            .header('cache-control', 'no-store, private')
            .header('x-content-type-options', 'nosniff')
            .send(csv);
    });
    app.get('/bots/:id/stats', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const stats = await (0, bot_service_js_1.getBotStats)(user.id, id);
        return { success: true, data: stats };
    });
    app.get('/bots/:id/conversations', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const q = parse(conversationQuery, req.query);
        const result = await (0, bot_service_js_1.listBotConversations)(user.id, id, q.page, q.pageSize, q.platformUserId);
        return { success: true, data: result };
    });
    app.get('/bots/:id/conversations/:conversationId/messages', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const conversationId = parseParam(ulidish, req.params.conversationId);
        const q = parse(paginationQuery, req.query);
        const result = await (0, bot_service_js_1.listBotConversationMessages)(user.id, id, conversationId, q.page, q.pageSize);
        return { success: true, data: result };
    });
    // UI uses this to disable unsupported actions (§16 — never emulate).
    app.get('/bots/:id/capabilities', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const capabilities = await (0, bot_service_js_1.getBotCapabilities)(user.id, id);
        return { success: true, data: { capabilities } };
    });
    // ---- commands ----
    app.get('/bots/:id/commands', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const items = await (0, bot_service_js_1.listBotCommands)(user.id, id);
        return { success: true, data: { items } };
    });
    app.post('/bots/:id/commands', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const input = parse(commandCreateSchema, req.body);
        const command = await (0, bot_service_js_1.createBotCommand)(user.id, id, {
            command: input.command,
            descriptionFa: input.descriptionFa,
            responseKind: input.responseKind,
            responsePayload: asPayload(input.responsePayload),
        });
        return { success: true, data: { command } };
    });
    app.put('/bots/:id/commands', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const body = parse(commandUpdateSchema.extend({ commandId: ulidish }), req.body);
        const command = await (0, bot_service_js_1.updateBotCommand)(user.id, body.commandId, {
            command: body.command,
            descriptionFa: body.descriptionFa,
            responseKind: body.responseKind,
            responsePayload: body.responsePayload === undefined ? undefined : asPayload(body.responsePayload),
            isEnabled: body.isEnabled,
        }, id);
        return { success: true, data: { command } };
    });
    app.delete('/bots/:id/commands', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const commandId = parseParam(ulidish, req.query.commandId);
        await (0, bot_service_js_1.deleteBotCommand)(user.id, commandId, id);
        return { success: true, data: { deleted: true } };
    });
    app.put('/bots/commands/:cmdId', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const cmdId = parseParam(ulidish, req.params.cmdId);
        const input = parse(commandUpdateSchema, req.body);
        const command = await (0, bot_service_js_1.updateBotCommand)(user.id, cmdId, {
            command: input.command,
            descriptionFa: input.descriptionFa,
            responseKind: input.responseKind,
            responsePayload: input.responsePayload === undefined ? undefined : asPayload(input.responsePayload),
            isEnabled: input.isEnabled,
        });
        return { success: true, data: { command } };
    });
    app.delete('/bots/commands/:cmdId', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const cmdId = parseParam(ulidish, req.params.cmdId);
        await (0, bot_service_js_1.deleteBotCommand)(user.id, cmdId);
        return { success: true, data: { deleted: true } };
    });
    // ---- keywords ----
    app.get('/bots/:id/keywords', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const items = await (0, bot_service_js_1.listBotKeywords)(user.id, id);
        return { success: true, data: { items } };
    });
    app.delete('/bots/:id/keywords', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const keywordId = parseParam(ulidish, req.query.keywordId);
        await (0, bot_service_js_1.deleteBotKeyword)(user.id, keywordId, id);
        return { success: true, data: { deleted: true } };
    });
    app.post('/bots/:id/keywords', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const id = parseParam(ulidish, req.params.id);
        const input = parse(keywordCreateSchema, req.body);
        const keyword = await (0, bot_service_js_1.createBotKeyword)(user.id, id, {
            keyword: input.keyword,
            matchKind: input.matchKind,
            responseKind: input.responseKind,
            responsePayload: asPayload(input.responsePayload),
        });
        return { success: true, data: { keyword } };
    });
    app.put('/bots/keywords/:kwId', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const kwId = parseParam(ulidish, req.params.kwId);
        const input = parse(keywordUpdateSchema, req.body);
        const keyword = await (0, bot_service_js_1.updateBotKeyword)(user.id, kwId, {
            keyword: input.keyword,
            matchKind: input.matchKind,
            responseKind: input.responseKind,
            responsePayload: input.responsePayload === undefined ? undefined : asPayload(input.responsePayload),
            isEnabled: input.isEnabled,
        });
        return { success: true, data: { keyword } };
    });
    app.delete('/bots/keywords/:kwId', { preHandler: app.requireAuth }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const kwId = parseParam(ulidish, req.params.kwId);
        await (0, bot_service_js_1.deleteBotKeyword)(user.id, kwId);
        return { success: true, data: { deleted: true } };
    });
    // ---- PUBLIC provider webhook (no auth; CSRF-exempt via buildApp skip on /api/v1/webhooks) ----
    app.post('/webhooks/bots/:botId', {
        preHandler: [webhook_rate_limit_js_1.enforceBotWebhookIpLimit], config: { rateLimit: { max: 5000, timeWindow: '1 minute', keyGenerator: (req) => String(req.params.botId ?? req.ip) } }
    }, async (req) => {
        const botId = req.params.botId;
        if (typeof botId !== 'string' || !ulidish.safeParse(botId).success) {
            return { success: true }; // never leak validity to the provider
        }
        const secret = req.query['s'];
        try {
            await (0, bot_service_js_1.ingestBotWebhook)(botId, secret, req.body, req.headers['x-telegram-bot-api-secret-token']);
        }
        catch (err) {
            // Return a retryable 5xx without exposing internals. Providers need a
            // non-2xx response when durable enqueue fails so the update can be
            // retried instead of being acknowledged and lost.
            req.log.error({ err, botId }, 'bot_webhook_ingest_failed');
            throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
        }
        return { success: true };
    });
}
