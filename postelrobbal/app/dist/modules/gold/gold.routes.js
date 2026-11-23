"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGoldRoutes = registerGoldRoutes;
const zod_1 = require("zod");
const errors_js_1 = require("../../core/errors.js");
const gold_service_js_1 = require("./gold.service.js");
const validation_js_1 = require("../../core/validation.js");
function actor(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return { tenantId: req.user.id, actorId: req.user.id, actorRole: req.user.role, ip: req.ip };
}
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
const configSchema = zod_1.z.object({
    sourceUrl: zod_1.z
        .string()
        .max(512)
        .nullish()
        .transform((v) => (typeof v === 'string' ? v.trim() : ''))
        .refine((v) => !v || zod_1.z.string().url().safeParse(v).success, {
        message: 'آدرس معتبر نیست.',
    })
        .default(''),
    apiToken: zod_1.z.string().max(1024).optional().nullable(),
    templateText: zod_1.z.string().min(1).max(4000),
    channelIds: zod_1.z.array(zod_1.z.string().min(10).max(26)).max(20),
    frequencyMinutes: zod_1.z.number().int().min(15).max(1440),
    timezone: zod_1.z.string().max(64).default('Asia/Tehran'),
    changeOnly: zod_1.z.boolean().default(true),
    isEnabled: zod_1.z.boolean().default(false),
});
async function registerGoldRoutes(app) {
    app.get('/gold/config', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const config = await (0, gold_service_js_1.getGoldConfig)(tenantId);
        return { success: true, data: { config } };
    });
    app.put('/gold/config', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId, ...meta } = actor(req);
        const input = parse(configSchema, req.body);
        const config = await (0, gold_service_js_1.saveGoldConfig)(tenantId, input);
        return { success: true, data: { config } };
    });
    app.post('/gold/run', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const result = await (0, gold_service_js_1.runNow)(tenantId);
        return { success: true, data: { result } };
    });
}
