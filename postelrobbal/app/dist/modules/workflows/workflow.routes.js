"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWorkflowRoutes = registerWorkflowRoutes;
const zod_1 = require("zod");
const errors_js_1 = require("../../core/errors.js");
const validation_js_1 = require("../../core/validation.js");
const workflow_service_js_1 = require("./workflow.service.js");
const ulidish = zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/, 'شناسه معتبر نیست.');
const paginationQuery = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    pageSize: zod_1.z.coerce.number().int().min(1).max(100).default(20),
});
const createSchema = zod_1.z.object({
    botId: ulidish,
    nameFa: zod_1.z.string().min(1).max(190),
    definition: zod_1.z.unknown(),
});
const updateSchema = zod_1.z.object({
    nameFa: zod_1.z.string().min(1).max(190).optional(),
    definition: zod_1.z.unknown().optional(),
    isEnabled: zod_1.z.boolean().optional(),
});
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
function mustTenantId(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return req.user.id;
}
function paramId(req) {
    const res = ulidish.safeParse(req.params['id']);
    if (!res.success)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('شناسه معتبر نیست.'));
    return res.data;
}
async function registerWorkflowRoutes(app) {
    app.get('/workflows', { preHandler: app.requireAuth }, async (req) => {
        const tenantId = mustTenantId(req);
        const q = parse(paginationQuery, req.query);
        const result = await (0, workflow_service_js_1.listWorkflows)(tenantId, q.page, q.pageSize);
        return { success: true, data: result };
    });
    app.post('/workflows', { preHandler: app.requireAuth }, async (req) => {
        const tenantId = mustTenantId(req);
        const input = parse(createSchema, req.body);
        const workflow = await (0, workflow_service_js_1.createWorkflow)(tenantId, input);
        return { success: true, data: { workflow } };
    });
    app.put('/workflows/:id', { preHandler: app.requireAuth }, async (req) => {
        const tenantId = mustTenantId(req);
        const id = paramId(req);
        const input = parse(updateSchema, req.body);
        const workflow = await (0, workflow_service_js_1.updateWorkflow)(tenantId, id, input);
        return { success: true, data: { workflow } };
    });
    app.delete('/workflows/:id', { preHandler: app.requireAuth }, async (req) => {
        const tenantId = mustTenantId(req);
        const id = paramId(req);
        await (0, workflow_service_js_1.deleteWorkflow)(tenantId, id);
        return { success: true, data: { deleted: true } };
    });
    app.post('/workflows/:id/enable', { preHandler: app.requireAuth }, async (req) => {
        const tenantId = mustTenantId(req);
        const id = paramId(req);
        const workflow = await (0, workflow_service_js_1.setWorkflowEnabled)(tenantId, id, true);
        return { success: true, data: { workflow } };
    });
    app.post('/workflows/:id/disable', { preHandler: app.requireAuth }, async (req) => {
        const tenantId = mustTenantId(req);
        const id = paramId(req);
        const workflow = await (0, workflow_service_js_1.setWorkflowEnabled)(tenantId, id, false);
        return { success: true, data: { workflow } };
    });
    app.get('/workflows/:id/runs', { preHandler: app.requireAuth }, async (req) => {
        const tenantId = mustTenantId(req);
        const id = paramId(req);
        const q = parse(paginationQuery, req.query);
        const result = await (0, workflow_service_js_1.listWorkflowRuns)(tenantId, id, q.page, q.pageSize);
        return { success: true, data: result };
    });
}
