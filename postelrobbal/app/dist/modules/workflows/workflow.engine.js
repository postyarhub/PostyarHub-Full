"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORKFLOW_LIMITS = void 0;
exports.prepareWorkflowButtons = prepareWorkflowButtons;
exports.parseWorkflowDefinition = parseWorkflowDefinition;
exports.executeWorkflow = executeWorkflow;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const plan_service_js_1 = require("../subscriptions/plan.service.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const events_js_1 = require("../../core/events.js");
const errors_js_1 = require("../../core/errors.js");
const button_target_js_1 = require("../../core/button-target.js");
const ai_service_js_1 = require("../ai/ai.service.js");
/**
 * Deterministic workflow interpreter (§190): hard safety limits, bounded
 * execution, persisted run log. Steps: MESSAGE | BUTTONS | AI | WAIT |
 * CONDITION (max 2 nested branch levels).
 */
exports.WORKFLOW_LIMITS = {
    maxSteps: 20,
    maxDurationMs: 60_000,
    maxNesting: 2,
    maxAiCalls: 2,
    maxOutbound: 10,
};
const DEFAULT_AI_PROMPT_FA = 'شما پاسخ‌گوی خودکار یک کسب‌وکار ایرانی هستید. کوتاه، مؤدبانه و فارسی پاسخ بده.';
class WorkflowTimeoutError extends Error {
    constructor() {
        super('WORKFLOW_TIMEOUT');
    }
}
class WorkflowLimitError extends Error {
    constructor(code) {
        super(code);
    }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function interpolate(vars, template) {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => vars[key] ?? '');
}
function coerceButtons(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const raw of value.slice(0, 8)) {
        if (!raw || typeof raw !== 'object')
            continue;
        const b = raw;
        if (typeof b['label'] !== 'string' || !b['label'])
            continue;
        let safeUrl;
        if (typeof b['url'] === 'string') {
            try {
                safeUrl = (0, button_target_js_1.normalizeButtonTargetValue)('URL', b['url'].slice(0, 255));
            }
            catch { /* drop legacy unsafe URL */ }
        }
        const callback = typeof b['callback'] === 'string' ? b['callback'].slice(0, 64) : undefined;
        if (!safeUrl && !callback)
            continue;
        out.push({
            label: b['label'].slice(0, 64),
            ...(safeUrl ? { url: safeUrl } : {}),
            ...(callback ? { callback } : {}),
        });
    }
    return out;
}
function prepareWorkflowButtons(buttons) {
    const safe = [];
    for (const b of buttons.slice(0, 8)) {
        let url;
        if (typeof b.url === 'string') {
            try {
                url = (0, button_target_js_1.normalizeButtonTargetValue)('URL', b.url.slice(0, 255));
            }
            catch { /* reject legacy unsafe URL */ }
        }
        const callback = typeof b.callback === 'string' ? b.callback.slice(0, 64) : undefined;
        if (!url && !callback)
            continue;
        safe.push({ label: b.label.slice(0, 64), ...(url ? { url } : {}), ...(callback ? { callback } : {}) });
    }
    return safe;
}
/** Defensive step coercion — malformed steps are dropped, never crash the run. */
function coerceStep(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const s = raw;
    switch (s['type']) {
        case 'MESSAGE':
            return typeof s['text'] === 'string' && s['text'].length > 0
                ? { type: 'MESSAGE', text: s['text'] }
                : null;
        case 'BUTTONS':
            return typeof s['text'] === 'string' && s['text'].length > 0
                ? { type: 'BUTTONS', text: s['text'], buttons: coerceButtons(s['buttons']) }
                : null;
        case 'AI':
            return typeof s['prompt'] === 'string' && s['prompt'].length > 0
                ? { type: 'AI', prompt: s['prompt'] }
                : null;
        case 'WAIT':
            return typeof s['seconds'] === 'number' && Number.isFinite(s['seconds'])
                ? { type: 'WAIT', seconds: s['seconds'] }
                : null;
        case 'CONDITION': {
            const then = Array.isArray(s['then'])
                ? s['then'].map(coerceStep).filter((x) => x !== null)
                : undefined;
            const els = Array.isArray(s['else'])
                ? s['else'].map(coerceStep).filter((x) => x !== null)
                : undefined;
            return {
                type: 'CONDITION',
                variable: typeof s['variable'] === 'string' ? s['variable'] : '',
                operator: s['operator'] === 'CONTAINS' ? 'CONTAINS' : 'EQUALS',
                value: typeof s['value'] === 'string' ? s['value'] : '',
                ...(then && then.length ? { then } : {}),
                ...(els && els.length ? { else: els } : {}),
            };
        }
        default:
            return null;
    }
}
function parseWorkflowDefinition(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const root = raw;
    if (!Array.isArray(root['steps']))
        return null;
    const steps = root['steps'].map(coerceStep).filter((x) => x !== null);
    if (steps.length === 0)
        return null;
    const triggerRaw = (root['trigger'] ?? {});
    return {
        trigger: {
            kind: typeof triggerRaw['kind'] === 'string' ? triggerRaw['kind'] : 'MESSAGE_RECEIVED',
            ...(typeof triggerRaw['keyword'] === 'string' ? { keyword: triggerRaw['keyword'] } : {}),
        },
        steps,
    };
}
/** Execute a workflow run: RUNNING → COMPLETED / FAILED / TIMEOUT. */
async function executeWorkflow(run, bot, send) {
    await (0, plan_service_js_1.assertFeature)(run.tenantId, 'auto_responder');
    const db = (0, client_js_1.getDb)();
    const runId = (0, ids_js_1.newId)();
    const startedAtMs = Date.now();
    const logEntries = [];
    let stepsExecuted = 0;
    let status = 'COMPLETED';
    let errorCode = null;
    await db.insert(schema_js_1.workflowRuns).values({
        id: runId,
        workflowId: run.workflowId,
        tenantId: run.tenantId,
        triggerKind: run.triggerKind,
        triggerRef: run.triggerRef,
        status: 'RUNNING',
    });
    await (0, events_js_1.emitEvent)({
        name: 'workflow.started',
        tenantId: run.tenantId,
        subjectType: 'workflow',
        subjectId: run.workflowId,
        props: { triggerKind: run.triggerKind, platform: bot.platform, source: 'workflow_engine' },
        analyticsDedupeKey: `workflow:${runId}:started`,
    });
    try {
        const [wf] = await db
            .select({ definitionJson: schema_js_1.workflows.definitionJson })
            .from(schema_js_1.workflows)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.workflows.id, run.workflowId), (0, drizzle_orm_1.eq)(schema_js_1.workflows.tenantId, run.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.workflows.botId, run.botId), (0, drizzle_orm_1.eq)(schema_js_1.workflows.isEnabled, 1)))
            .limit(1);
        const def = parseWorkflowDefinition(wf?.definitionJson);
        if (!def)
            throw new WorkflowLimitError('WORKFLOW_DEFINITION_INVALID');
        let outbound = 0;
        let aiCalls = 0;
        const assertBudget = () => {
            if (Date.now() - startedAtMs > exports.WORKFLOW_LIMITS.maxDurationMs)
                throw new WorkflowTimeoutError();
        };
        const chatRef = run.variables['chatRef'] ?? '';
        const execStep = async (step, depth) => {
            if (stepsExecuted >= exports.WORKFLOW_LIMITS.maxSteps)
                throw new WorkflowLimitError('WORKFLOW_STEP_LIMIT');
            stepsExecuted++;
            assertBudget();
            switch (step.type) {
                case 'MESSAGE': {
                    if (outbound >= exports.WORKFLOW_LIMITS.maxOutbound)
                        throw new WorkflowLimitError('WORKFLOW_OUTBOUND_LIMIT');
                    outbound++;
                    await send(chatRef, interpolate(run.variables, step.text));
                    logEntries.push({ step: stepsExecuted, type: 'MESSAGE' });
                    return;
                }
                case 'BUTTONS': {
                    if (outbound >= exports.WORKFLOW_LIMITS.maxOutbound)
                        throw new WorkflowLimitError('WORKFLOW_OUTBOUND_LIMIT');
                    outbound++;
                    const buttons = prepareWorkflowButtons(step.buttons);
                    await send(chatRef, interpolate(run.variables, step.text), buttons.length ? buttons : undefined);
                    logEntries.push({ step: stepsExecuted, type: 'BUTTONS' });
                    return;
                }
                case 'AI': {
                    if (aiCalls >= exports.WORKFLOW_LIMITS.maxAiCalls)
                        throw new WorkflowLimitError('WORKFLOW_AI_LIMIT');
                    aiCalls++;
                    const system = interpolate(run.variables, step.prompt) || bot.aiSystemPrompt || DEFAULT_AI_PROMPT_FA;
                    const reply = await (0, ai_service_js_1.aiProviderComplete)(run.tenantId, system, run.variables['text'] ?? '', { purpose: 'AUTO_REPLY', source: 'workflow', subjectType: 'workflow', subjectId: run.workflowId });
                    if (outbound >= exports.WORKFLOW_LIMITS.maxOutbound)
                        throw new WorkflowLimitError('WORKFLOW_OUTBOUND_LIMIT');
                    outbound++;
                    await send(chatRef, reply);
                    logEntries.push({ step: stepsExecuted, type: 'AI' });
                    return;
                }
                case 'WAIT': {
                    const seconds = Math.max(0, Math.min(60, Math.floor(step.seconds)));
                    if (Date.now() - startedAtMs + seconds * 1000 > exports.WORKFLOW_LIMITS.maxDurationMs) {
                        throw new WorkflowTimeoutError();
                    }
                    await sleep(seconds * 1000);
                    logEntries.push({ step: stepsExecuted, type: 'WAIT', note: `${seconds}s` });
                    return;
                }
                case 'CONDITION': {
                    if (depth + 1 > exports.WORKFLOW_LIMITS.maxNesting)
                        throw new WorkflowLimitError('WORKFLOW_NESTING_LIMIT');
                    const actual = run.variables[step.variable] ?? '';
                    const target = interpolate(run.variables, step.value);
                    const pass = step.operator === 'EQUALS' ? actual === target : actual.toLowerCase().includes(target.toLowerCase());
                    const branch = pass ? (step.then ?? []) : (step.else ?? []);
                    logEntries.push({ step: stepsExecuted, type: 'CONDITION', note: pass ? 'then' : 'else' });
                    for (const child of branch)
                        await execStep(child, depth + 1);
                    return;
                }
                default:
                    throw new WorkflowLimitError('WORKFLOW_STEP_INVALID');
            }
        };
        for (const step of def.steps) {
            await execStep(step, 0);
            assertBudget();
        }
        await db
            .update(schema_js_1.workflows)
            .set({ runCount: (0, drizzle_orm_1.sql) `${schema_js_1.workflows.runCount} + 1` })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.workflows.id, run.workflowId), (0, drizzle_orm_1.eq)(schema_js_1.workflows.tenantId, run.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.workflows.botId, run.botId)));
    }
    catch (err) {
        if (err instanceof WorkflowTimeoutError) {
            status = 'TIMEOUT';
            errorCode = 'WORKFLOW_TIMEOUT';
        }
        else if (err instanceof WorkflowLimitError) {
            status = 'FAILED';
            errorCode = err.message.slice(0, 80);
        }
        else if (err instanceof errors_js_1.AppError) {
            status = 'FAILED';
            errorCode = err.code.slice(0, 80);
        }
        else {
            status = 'FAILED';
            errorCode = 'WORKFLOW_STEP_FAILED';
        }
    }
    const finishedAt = new Date();
    await db
        .update(schema_js_1.workflowRuns)
        .set({
        status,
        stepsExecuted,
        logJson: logEntries.length ? logEntries : null,
        errorCode,
        finishedAt,
    })
        .where((0, drizzle_orm_1.eq)(schema_js_1.workflowRuns.id, runId));
    await (0, events_js_1.emitEvent)({
        name: status === 'COMPLETED' ? 'workflow.completed' : 'workflow.failed',
        tenantId: run.tenantId,
        subjectType: 'workflow',
        subjectId: run.workflowId,
        props: {
            status,
            platform: bot.platform,
            source: 'workflow_engine',
            stepsExecuted,
            outboundMessages: Math.min(logEntries.filter((x) => x.type === 'MESSAGE' || x.type === 'BUTTONS' || x.type === 'AI').length, exports.WORKFLOW_LIMITS.maxOutbound),
            aiCalls: logEntries.filter((x) => x.type === 'AI').length,
            durationMs: Math.max(0, finishedAt.getTime() - new Date(startedAtMs).getTime()),
            ...(errorCode ? { errorCode } : {}),
        },
        analyticsDedupeKey: `workflow:${runId}:${status.toLowerCase()}`,
    });
    // Caller-facing: engine never throws after the run row is finalized.
    if (status === 'FAILED' && errorCode === 'WORKFLOW_DEFINITION_INVALID') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ساختار گردش کار معتبر نیست.'));
    }
}
