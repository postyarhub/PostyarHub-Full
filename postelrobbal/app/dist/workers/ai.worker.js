"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAiWorker = startAiWorker;
const drizzle_orm_1 = require("drizzle-orm");
const connection_js_1 = require("../queue/connection.js");
const env_js_1 = require("../config/env.js");
const client_js_1 = require("../db/client.js");
const schema_js_1 = require("../db/schema.js");
const ai_providers_js_1 = require("../providers/ai/ai-providers.js");
const system_settings_service_js_1 = require("../modules/admin/system-settings.service.js");
const ai_service_js_1 = require("../modules/ai/ai.service.js");
const events_js_1 = require("../core/events.js");
const errors_js_1 = require("../core/errors.js");
const logger_js_1 = require("../core/logger.js");
const CAPTION_SYSTEM_FA = 'یک کپشن کوتاه، خوانا و جذاب به زبان فارسی برای متن کاربر بنویس. بدون HTML، حداکثر ۳ پاراگراف و در صورت تناسب از ایموجی استفاده کن.';
/**
 * AI jobs worker: QUEUED → RUNNING → COMPLETED/FAILED. Bounded by the hard
 * timeout inside aiComplete; failures are terminal (no retry of misconfigured
 * or quota-exhausted jobs).
 */
function startAiWorker() {
    const env = (0, env_js_1.loadEnv)();
    const log = (0, logger_js_1.createLogger)('ai-worker');
    const processor = async (job) => {
        const data = job.data;
        if (typeof data.jobId !== 'string')
            return;
        const db = (0, client_js_1.getDb)();
        const [aiJob] = await db.select().from(schema_js_1.aiJobs).where((0, drizzle_orm_1.eq)(schema_js_1.aiJobs.id, data.jobId)).limit(1);
        if (!aiJob || aiJob.status !== 'QUEUED')
            return; // idempotent: never re-run a started job
        // Claim atomically. A duplicated BullMQ job or a second worker process must
        // never be allowed to run the same billable AI request concurrently.
        const claimed = await db
            .update(schema_js_1.aiJobs)
            .set({ status: 'RUNNING' })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.aiJobs.id, aiJob.id), (0, drizzle_orm_1.eq)(schema_js_1.aiJobs.status, 'QUEUED')));
        const affected = Array.isArray(claimed)
            ? Number(claimed[0]?.affectedRows ?? 0)
            : Number(claimed?.affectedRows ?? 0);
        if (affected === 0)
            return;
        const startedAt = Date.now();
        try {
            // Round 18: admin-stored key/custom base URL/model override the env defaults.
            const provider = aiJob.provider || 'openai';
            const override = await (0, system_settings_service_js_1.resolveAiRuntimeOverride)(provider);
            const result = await (0, ai_providers_js_1.aiComplete)(provider, {
                ...(aiJob.purpose === 'CAPTION' ? { system: CAPTION_SYSTEM_FA } : {}),
                user: aiJob.inputText,
                timeoutMs: 30_000,
                maxTokens: 700,
            }, override);
            const tokenCount = (result.promptTokens ?? 0) + (result.completionTokens ?? 0);
            try {
                await (0, ai_service_js_1.recordAiTokens)(aiJob.tenantId, tokenCount);
            }
            catch {
                log.warn({ jobId: aiJob.id }, 'ai_token_accounting_failed');
            }
            await db
                .update(schema_js_1.aiJobs)
                .set({
                status: 'COMPLETED',
                outputText: result.text,
                promptTokens: result.promptTokens ?? null,
                completionTokens: result.completionTokens ?? null,
                finishedAt: new Date(),
            })
                .where((0, drizzle_orm_1.eq)(schema_js_1.aiJobs.id, aiJob.id));
            try {
                await (0, events_js_1.emitEvent)({
                    name: 'ai.completed',
                    tenantId: aiJob.tenantId,
                    subjectType: 'ai_job',
                    subjectId: aiJob.id,
                    props: {
                        purpose: aiJob.purpose,
                        provider: aiJob.provider,
                        source: 'queue',
                        durationMs: Date.now() - startedAt,
                        promptTokens: result.promptTokens ?? 0,
                        completionTokens: result.completionTokens ?? 0,
                        tokenCount,
                    },
                    analyticsDedupeKey: `ai:${aiJob.id}:completed`,
                });
            }
            catch {
                log.warn({ jobId: aiJob.id }, 'ai_completion_telemetry_failed');
            }
        }
        catch (err) {
            const code = err instanceof errors_js_1.AppError ? err.code : 'AI_FAILED';
            await db
                .update(schema_js_1.aiJobs)
                .set({ status: 'FAILED', errorCode: code.slice(0, 80), finishedAt: new Date() })
                .where((0, drizzle_orm_1.eq)(schema_js_1.aiJobs.id, aiJob.id));
            try {
                await (0, events_js_1.emitEvent)({
                    name: 'ai.failed',
                    tenantId: aiJob.tenantId,
                    subjectType: 'ai_job',
                    subjectId: aiJob.id,
                    props: { purpose: aiJob.purpose, provider: aiJob.provider, source: 'queue', errorCode: code, durationMs: Date.now() - startedAt },
                    analyticsDedupeKey: `ai:${aiJob.id}:failed`,
                });
            }
            catch {
                log.warn({ jobId: aiJob.id }, 'ai_failure_telemetry_failed');
            }
            log.warn({ jobId: aiJob.id, code }, 'ai_job_failed');
        }
    };
    return (0, connection_js_1.createWorker)('ai-jobs', processor, { concurrency: env.AI_WORKER_CONCURRENCY });
}
