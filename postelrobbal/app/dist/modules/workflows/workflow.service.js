"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOwnedWorkflow = getOwnedWorkflow;
exports.listWorkflows = listWorkflows;
exports.createWorkflow = createWorkflow;
exports.updateWorkflow = updateWorkflow;
exports.deleteWorkflow = deleteWorkflow;
exports.setWorkflowEnabled = setWorkflowEnabled;
exports.listWorkflowRuns = listWorkflowRuns;
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const errors_js_1 = require("../../core/errors.js");
const button_target_js_1 = require("../../core/button-target.js");
const audit_js_1 = require("../../core/audit.js");
const workflow_engine_js_1 = require("./workflow.engine.js");
const bot_service_js_1 = require("../bots/bot.service.js");
const plan_service_js_1 = require("../subscriptions/plan.service.js");
const workflowButtonUrlSchema = zod_1.z.string().trim().min(1).max(255).transform((value, ctx) => {
    try {
        return (0, button_target_js_1.normalizeButtonTargetValue)('URL', value);
    }
    catch {
        ctx.addIssue({ code: zod_1.z.ZodIssueCode.custom, message: 'نشانی دکمه باید یک لینک معتبر HTTP یا HTTPS باشد.' });
        return zod_1.z.NEVER;
    }
});
const buttonSchema = zod_1.z.object({
    label: zod_1.z.string().min(1).max(64),
    url: workflowButtonUrlSchema.optional(),
    callback: zod_1.z.string().max(64).optional(),
});
const conditionSchema = zod_1.z.object({
    type: zod_1.z.literal('CONDITION'),
    variable: zod_1.z.string().min(1).max(64),
    operator: zod_1.z.enum(['EQUALS', 'CONTAINS']),
    value: zod_1.z.string().max(400),
    then: zod_1.z.array(zod_1.z.lazy(() => stepSchema)).max(10).optional(),
    else: zod_1.z.array(zod_1.z.lazy(() => stepSchema)).max(10).optional(),
});
const stepSchema = zod_1.z.discriminatedUnion('type', [
    zod_1.z.object({ type: zod_1.z.literal('MESSAGE'), text: zod_1.z.string().min(1).max(4000) }),
    zod_1.z.object({ type: zod_1.z.literal('BUTTONS'), text: zod_1.z.string().min(1).max(4000), buttons: zod_1.z.array(buttonSchema).min(1).max(8) }),
    zod_1.z.object({ type: zod_1.z.literal('AI'), prompt: zod_1.z.string().min(1).max(4000) }),
    zod_1.z.object({ type: zod_1.z.literal('WAIT'), seconds: zod_1.z.number().int().min(1).max(60) }),
    conditionSchema,
]);
const definitionSchema = zod_1.z.object({
    trigger: zod_1.z.object({
        kind: zod_1.z.literal('MESSAGE_RECEIVED'),
        keyword: zod_1.z.string().max(190).optional(),
    }),
    steps: zod_1.z.array(stepSchema).min(1).max(workflow_engine_js_1.WORKFLOW_LIMITS.maxSteps),
});
function countSteps(steps) {
    let count = 0;
    for (const s of steps) {
        count++;
        if (s.type === 'CONDITION') {
            count += s.then ? countSteps(s.then) : 0;
            count += s.else ? countSteps(s.else) : 0;
        }
    }
    return count;
}
function parseDefinition(raw) {
    const res = definitionSchema.safeParse(raw);
    if (!res.success) {
        const first = res.error.issues[0];
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`ساختار گردش کار معتبر نیست.${first ? ` (${first.path.join('.')})` : ''}`));
    }
    if (countSteps(res.data.steps) > workflow_engine_js_1.WORKFLOW_LIMITS.maxSteps) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('تعداد گام‌های گردش کار بیش از حد مجاز است.'));
    }
    return res.data;
}
async function getOwnedWorkflow(tenantId, workflowId) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'auto_responder');
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select()
        .from(schema_js_1.workflows)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.workflows.id, workflowId), (0, drizzle_orm_1.eq)(schema_js_1.workflows.tenantId, tenantId)))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('گردش کار'));
    return row;
}
async function listWorkflows(tenantId, page, pageSize) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'auto_responder');
    const db = (0, client_js_1.getDb)();
    const items = await db
        .select()
        .from(schema_js_1.workflows)
        .where((0, drizzle_orm_1.eq)(schema_js_1.workflows.tenantId, tenantId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.workflows.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
    const [countRow] = await db
        .select({ count: (0, drizzle_orm_1.sql) `count(*)` })
        .from(schema_js_1.workflows)
        .where((0, drizzle_orm_1.eq)(schema_js_1.workflows.tenantId, tenantId));
    return { items, total: Number(countRow?.count ?? 0), page, pageSize };
}
async function createWorkflow(tenantId, input) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'auto_responder');
    const bot = await (0, bot_service_js_1.getOwnedBot)(tenantId, input.botId); // plan + ownership validation
    const definition = parseDefinition(input.definition);
    const db = (0, client_js_1.getDb)();
    const id = (0, ids_js_1.newId)();
    await db.insert(schema_js_1.workflows).values({
        id,
        tenantId,
        botId: bot.id,
        nameFa: input.nameFa.trim().slice(0, 190),
        definitionJson: definition,
    });
    await (0, audit_js_1.audit)({ action: 'workflow.create', actorId: tenantId, subjectType: 'workflow', subjectId: id, meta: { botId: bot.id } });
    return getOwnedWorkflow(tenantId, id);
}
async function updateWorkflow(tenantId, workflowId, patch) {
    await getOwnedWorkflow(tenantId, workflowId);
    const db = (0, client_js_1.getDb)();
    await db
        .update(schema_js_1.workflows)
        .set({
        ...(patch.nameFa !== undefined ? { nameFa: patch.nameFa.trim().slice(0, 190) } : {}),
        ...(patch.definition !== undefined ? { definitionJson: parseDefinition(patch.definition) } : {}),
        ...(patch.isEnabled !== undefined ? { isEnabled: patch.isEnabled ? 1 : 0 } : {}),
    })
        .where((0, drizzle_orm_1.eq)(schema_js_1.workflows.id, workflowId));
    await (0, audit_js_1.audit)({ action: 'workflow.update', actorId: tenantId, subjectType: 'workflow', subjectId: workflowId });
    return getOwnedWorkflow(tenantId, workflowId);
}
async function deleteWorkflow(tenantId, workflowId) {
    await getOwnedWorkflow(tenantId, workflowId);
    const db = (0, client_js_1.getDb)();
    await db.delete(schema_js_1.workflowRuns).where((0, drizzle_orm_1.eq)(schema_js_1.workflowRuns.workflowId, workflowId));
    await db.delete(schema_js_1.workflows).where((0, drizzle_orm_1.eq)(schema_js_1.workflows.id, workflowId));
    await (0, audit_js_1.audit)({ action: 'workflow.delete', actorId: tenantId, subjectType: 'workflow', subjectId: workflowId });
}
async function setWorkflowEnabled(tenantId, workflowId, isEnabled) {
    await getOwnedWorkflow(tenantId, workflowId);
    const db = (0, client_js_1.getDb)();
    await db.update(schema_js_1.workflows).set({ isEnabled: isEnabled ? 1 : 0 }).where((0, drizzle_orm_1.eq)(schema_js_1.workflows.id, workflowId));
    await (0, audit_js_1.audit)({
        action: isEnabled ? 'workflow.enable' : 'workflow.disable',
        actorId: tenantId,
        subjectType: 'workflow',
        subjectId: workflowId,
    });
    return getOwnedWorkflow(tenantId, workflowId);
}
async function listWorkflowRuns(tenantId, workflowId, page, pageSize) {
    await getOwnedWorkflow(tenantId, workflowId);
    const db = (0, client_js_1.getDb)();
    const items = await db
        .select({
        id: schema_js_1.workflowRuns.id,
        workflowId: schema_js_1.workflowRuns.workflowId,
        triggerKind: schema_js_1.workflowRuns.triggerKind,
        triggerRef: schema_js_1.workflowRuns.triggerRef,
        status: schema_js_1.workflowRuns.status,
        stepsExecuted: schema_js_1.workflowRuns.stepsExecuted,
        logJson: schema_js_1.workflowRuns.logJson,
        errorCode: schema_js_1.workflowRuns.errorCode,
        startedAt: schema_js_1.workflowRuns.startedAt,
        finishedAt: schema_js_1.workflowRuns.finishedAt,
    })
        .from(schema_js_1.workflowRuns)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.workflowRuns.workflowId, workflowId), (0, drizzle_orm_1.eq)(schema_js_1.workflowRuns.tenantId, tenantId)))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.workflowRuns.startedAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
    const [countRow] = await db
        .select({ count: (0, drizzle_orm_1.sql) `count(*)` })
        .from(schema_js_1.workflowRuns)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.workflowRuns.workflowId, workflowId), (0, drizzle_orm_1.eq)(schema_js_1.workflowRuns.tenantId, tenantId)));
    return { items, total: Number(countRow?.count ?? 0), page, pageSize };
}
