"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.consumeAiQuota = consumeAiQuota;
exports.requestAiJob = requestAiJob;
exports.requestAiCaption = requestAiCaption;
exports.recordAiTokens = recordAiTokens;
exports.aiProviderComplete = aiProviderComplete;
exports.generateAiSync = generateAiSync;
exports.getAiJob = getAiJob;
exports.getAiUsage = getAiUsage;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const errors_js_1 = require("../../core/errors.js");
const events_js_1 = require("../../core/events.js");
const outbox_js_1 = require("../../core/outbox.js");
const logger_js_1 = require("../../core/logger.js");
const queues_js_1 = require("../../queue/queues.js");
const plan_service_js_1 = require("../subscriptions/plan.service.js");
const ai_providers_js_1 = require("../../providers/ai/ai-providers.js");
const system_settings_service_js_1 = require("../admin/system-settings.service.js");
const log = (0, logger_js_1.createLogger)('ai-service');
function currentPeriodYm() {
    return new Date().toISOString().slice(0, 7); // YYYY-MM UTC
}
async function consumeAiQuotaTx(tx, tenantId, limit, periodYm) {
    // AI is a paid entitlement: zero (including a missing legacy value) means
    // disabled, never unlimited. Keep this guard at the accounting boundary so
    // queued and direct-worker paths share the same policy.
    if (!Number.isFinite(limit) || limit <= 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.PLAN_FEATURE_REQUIRED('هوش مصنوعی'));
    }
    await tx.insert(schema_js_1.aiUsageMonthly).values({
        tenantId,
        periodYm,
        requestCount: 0,
        tokenCount: 0,
    }).onDuplicateKeyUpdate({
        set: { tenantId: (0, drizzle_orm_1.sql) `${schema_js_1.aiUsageMonthly.tenantId}` },
    });
    const raw = await tx.execute((0, drizzle_orm_1.sql) `
    SELECT request_count
    FROM ai_usage_monthly
    WHERE tenant_id = ${tenantId} AND period_ym = ${periodYm}
    FOR UPDATE
  `);
    const rows = (Array.isArray(raw) ? raw[0] : []);
    const used = Number(rows[0]?.request_count ?? 0);
    if (used >= limit) {
        throw new errors_js_1.AppError(errors_js_1.ERR.QUOTA_EXCEEDED('هوش مصنوعی'));
    }
    await tx.update(schema_js_1.aiUsageMonthly)
        .set({ requestCount: (0, drizzle_orm_1.sql) `${schema_js_1.aiUsageMonthly.requestCount} + 1` })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.aiUsageMonthly.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.aiUsageMonthly.periodYm, periodYm)));
}
async function consumeAiQuota(tenantId) {
    const ctx = await (0, plan_service_js_1.getPlanContext)(tenantId);
    const limit = Number(ctx.limits.ai_monthly ?? 0);
    const periodYm = currentPeriodYm();
    await (0, client_js_1.getDb)().transaction((tx) => consumeAiQuotaTx(tx, tenantId, limit, periodYm));
}
async function countTokens(tenantId, tokens) {
    if (tokens <= 0)
        return;
    const db = (0, client_js_1.getDb)();
    await db
        .update(schema_js_1.aiUsageMonthly)
        .set({ tokenCount: (0, drizzle_orm_1.sql) `${schema_js_1.aiUsageMonthly.tokenCount} + ${tokens}` })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.aiUsageMonthly.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.aiUsageMonthly.periodYm, currentPeriodYm())));
}
/** Default provider: explicit override → system_settings['ai'].default_provider → 'openai'. */
async function resolveProvider(explicit) {
    const settings = await (0, system_settings_service_js_1.getAiSettings)();
    if (explicit && explicit.trim()) {
        const p = explicit.trim().toLowerCase();
        if (settings.providers.some((x) => x.id === p))
            return p;
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('سرویس‌دهندهٔ هوش مصنوعی پشتیبانی نمی‌شود.'));
    }
    return settings.defaultProvider || settings.providers[0]?.id || 'openai';
}
async function requestAiJob(tenantId, input) {
    // Resolve configuration before quota consumption so invalid provider input is
    // never charged as a successful AI request.
    const provider = await resolveProvider(input.provider);
    const ctx = await (0, plan_service_js_1.getPlanContext)(tenantId);
    const limit = Number(ctx.limits.ai_monthly ?? 0);
    const periodYm = currentPeriodYm();
    const db = (0, client_js_1.getDb)();
    const jobId = (0, ids_js_1.newId)();
    // AI job + quota + durable queue intent commit together. A Redis outage after
    // this transaction no longer loses the job or burns quota without a recoverable
    // work record; the outbox relay can dispatch it later.
    await db.transaction(async (tx) => {
        await consumeAiQuotaTx(tx, tenantId, limit, periodYm);
        await tx.insert(schema_js_1.aiJobs).values({
            id: jobId,
            tenantId,
            purpose: input.purpose,
            provider,
            inputText: input.inputText,
        });
        await tx.insert(schema_js_1.outboxEvents).values((0, outbox_js_1.outboxRow)({
            aggregateType: 'ai',
            aggregateId: jobId,
            eventType: 'ai.run',
            payload: { jobId },
        }));
    });
    // Fast path only. The durable outbox remains the recovery path.
    try {
        await (0, queues_js_1.enqueue)('ai-jobs', 'run', { jobId }, { jobId: `ai:${jobId}` });
    }
    catch (err) {
        log.warn({ jobId, errorName: err instanceof Error ? err.name : 'Error', errorMessage: String(err instanceof Error ? err.message : err ?? '').slice(0, 200) }, 'ai_job_fast_path_enqueue_failed');
    }
    await safeEmitEvent({
        name: 'ai.requested',
        tenantId,
        subjectType: 'ai_job',
        subjectId: jobId,
        props: { purpose: input.purpose, provider, source: 'queue' },
        analyticsDedupeKey: `ai:${jobId}:requested`,
    });
    return { jobId };
}
/** Queue-backed caption generation — the frontend polls GET /ai/jobs/:id. */
async function requestAiCaption(tenantId, text) {
    return requestAiJob(tenantId, { purpose: 'CAPTION', inputText: text });
}
/** Token accounting for queue workers and other async callers. */
async function recordAiTokens(tenantId, tokens) {
    await countTokens(tenantId, tokens);
}
/** Direct provider completion with first-class analytics telemetry. */
async function safeEmitEvent(input) {
    try {
        await (0, events_js_1.emitEvent)(input);
    }
    catch {
        // Telemetry must never turn a successful provider call into a failed business operation.
    }
}
async function aiProviderComplete(tenantId, system, user, context = {}) {
    const purpose = context.purpose ?? 'AUTO_REPLY';
    const source = context.source ?? 'direct';
    const requestedAt = new Date();
    let provider = 'openai';
    try {
        provider = await resolveProvider(undefined);
        await consumeAiQuota(tenantId);
    }
    catch (err) {
        const code = err instanceof errors_js_1.AppError ? err.code : 'AI_QUOTA_EXCEEDED';
        await safeEmitEvent({
            name: 'ai.failed',
            tenantId,
            subjectType: context.subjectType ?? 'ai_request',
            subjectId: context.subjectId,
            props: { purpose, provider, source, errorCode: code },
        });
        throw err;
    }
    await safeEmitEvent({
        name: 'ai.requested',
        tenantId,
        subjectType: context.subjectType ?? 'ai_request',
        subjectId: context.subjectId,
        props: { purpose, provider, source, requestedAt: requestedAt.toISOString() },
        analyticsDedupeKey: context.subjectId ? `ai:${context.subjectId}:requested:${requestedAt.getTime()}` : null,
    });
    const startedAt = Date.now();
    try {
        const override = await (0, system_settings_service_js_1.resolveAiRuntimeOverride)(provider);
        const result = await (0, ai_providers_js_1.aiComplete)(provider, { system, user, timeoutMs: 30_000, maxTokens: 500 }, override);
        const tokenCount = (result.promptTokens ?? 0) + (result.completionTokens ?? 0);
        try {
            await countTokens(tenantId, tokenCount);
        }
        catch { /* usage accounting is best-effort */ }
        await safeEmitEvent({
            name: 'ai.completed',
            tenantId,
            subjectType: context.subjectType ?? 'ai_request',
            subjectId: context.subjectId,
            props: {
                purpose,
                provider,
                source,
                durationMs: Date.now() - startedAt,
                promptTokens: result.promptTokens ?? 0,
                completionTokens: result.completionTokens ?? 0,
                tokenCount,
            },
            analyticsDedupeKey: context.subjectId ? `ai:${context.subjectId}:completed:${requestedAt.getTime()}` : null,
        });
        return result.text;
    }
    catch (err) {
        const code = err instanceof errors_js_1.AppError ? err.code : 'AI_FAILED';
        await safeEmitEvent({
            name: 'ai.failed',
            tenantId,
            subjectType: context.subjectType ?? 'ai_request',
            subjectId: context.subjectId,
            props: { purpose, provider, source, errorCode: code, durationMs: Date.now() - startedAt },
            analyticsDedupeKey: context.subjectId ? `ai:${context.subjectId}:failed:${requestedAt.getTime()}` : null,
        });
        throw err;
    }
}
/** Synchronous small completion for settings testing — quota-guarded, 30s. */
async function generateAiSync(tenantId, input) {
    const purpose = 'CUSTOM';
    const startedAt = Date.now();
    let provider = 'openai';
    try {
        provider = await resolveProvider(undefined);
        await consumeAiQuota(tenantId);
        await safeEmitEvent({
            name: 'ai.requested',
            tenantId,
            subjectType: 'ai_settings_test',
            props: { purpose, provider, source: 'settings_test' },
        });
        const override = await (0, system_settings_service_js_1.resolveAiRuntimeOverride)(provider);
        const result = await (0, ai_providers_js_1.aiComplete)(provider, {
            ...(input.system ? { system: input.system } : {}),
            user: input.text,
            timeoutMs: 30_000,
            maxTokens: 500,
        }, override);
        const tokenCount = (result.promptTokens ?? 0) + (result.completionTokens ?? 0);
        try {
            await countTokens(tenantId, tokenCount);
        }
        catch { /* usage accounting is best-effort */ }
        await safeEmitEvent({
            name: 'ai.completed',
            tenantId,
            subjectType: 'ai_settings_test',
            props: {
                purpose,
                provider,
                source: 'settings_test',
                durationMs: Date.now() - startedAt,
                promptTokens: result.promptTokens ?? 0,
                completionTokens: result.completionTokens ?? 0,
                tokenCount,
            },
        });
        return { text: result.text, provider };
    }
    catch (err) {
        const code = err instanceof errors_js_1.AppError ? err.code : 'AI_FAILED';
        await safeEmitEvent({
            name: 'ai.failed',
            tenantId,
            subjectType: 'ai_settings_test',
            props: { purpose, provider, source: 'settings_test', errorCode: code, durationMs: Date.now() - startedAt },
        });
        throw err;
    }
}
async function getAiJob(tenantId, jobId) {
    const db = (0, client_js_1.getDb)();
    const [job] = await db
        .select()
        .from(schema_js_1.aiJobs)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.aiJobs.id, jobId), (0, drizzle_orm_1.eq)(schema_js_1.aiJobs.tenantId, tenantId)))
        .limit(1);
    if (!job)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('درخواست هوش مصنوعی'));
    return {
        id: job.id,
        purpose: job.purpose,
        provider: job.provider,
        status: job.status,
        inputText: job.inputText,
        outputText: job.outputText,
        promptTokens: job.promptTokens,
        completionTokens: job.completionTokens,
        errorCode: job.errorCode,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
    };
}
async function getAiUsage(tenantId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select()
        .from(schema_js_1.aiUsageMonthly)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.aiUsageMonthly.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.aiUsageMonthly.periodYm, currentPeriodYm())))
        .limit(1);
    return {
        periodYm: currentPeriodYm(),
        requestCount: row?.requestCount ?? 0,
        tokenCount: row?.tokenCount ?? 0,
    };
}
