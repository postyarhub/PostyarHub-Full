"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAiRoutes = registerAiRoutes;
const zod_1 = require("zod");
const errors_js_1 = require("../../core/errors.js");
const ai_service_js_1 = require("./ai.service.js");
const validation_js_1 = require("../../core/validation.js");
const captionSchema = zod_1.z.object({ text: zod_1.z.string().min(1).max(4000) });
const generateSchema = zod_1.z.object({
    text: zod_1.z.string().min(1).max(4000),
    system: zod_1.z.string().min(1).max(4000).optional(),
});
const idParam = zod_1.z.object({ id: zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-z]{26}$/, 'شناسه معتبر نیست.') });
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
function mustTenantId(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return req.user.id;
}
async function registerAiRoutes(app) {
    // Caption generation is queued; the frontend polls GET /ai/jobs/:jobId.
    app.post('/ai/caption', { preHandler: app.requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: (req) => req.user?.id ?? req.ip } } }, async (req) => {
        const tenantId = mustTenantId(req);
        const input = parse(captionSchema, req.body);
        const { jobId } = await (0, ai_service_js_1.requestAiCaption)(tenantId, input.text);
        return { success: true, data: { jobId } };
    });
    app.get('/ai/jobs/:id', { preHandler: app.requireAuth }, async (req) => {
        const tenantId = mustTenantId(req);
        const { id } = parse(idParam, req.params);
        const job = await (0, ai_service_js_1.getAiJob)(tenantId, id);
        return { success: true, data: { job } };
    });
    app.get('/ai/usage', { preHandler: app.requireAuth }, async (req) => {
        const tenantId = mustTenantId(req);
        const usage = await (0, ai_service_js_1.getAiUsage)(tenantId);
        return { success: true, data: usage };
    });
    // Synchronous small completion for settings testing — quota-guarded, 30s.
    app.post('/ai/generate', { preHandler: app.requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req) => req.user?.id ?? req.ip } } }, async (req) => {
        const tenantId = mustTenantId(req);
        const input = parse(generateSchema, req.body);
        const result = await (0, ai_service_js_1.generateAiSync)(tenantId, { ...(input.system ? { system: input.system } : {}), text: input.text });
        return { success: true, data: { text: result.text, provider: result.provider } };
    });
}
