"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startNotificationWorker = startNotificationWorker;
const connection_js_1 = require("../queue/connection.js");
const logger_js_1 = require("../core/logger.js");
const env_js_1 = require("../config/env.js");
const delivery_js_1 = require("../modules/notifications/delivery.js");
const email_js_1 = require("../providers/email/email.js");
const system_settings_service_js_1 = require("../modules/admin/system-settings.service.js");
const templates_js_1 = require("../providers/email/templates.js");
const email_notifications_js_1 = require("../modules/notifications/email-notifications.js");
/**
 * Notifications worker (§27): in-app rows are already written synchronously;
 * this worker performs the outbound channel deliveries (expiry warnings) and
 * password-reset emails — honestly: when SMTP is not configured, no fake
 * success is reported and the user gets a generic in-app notice instead.
 * Reset tokens are NEVER logged (§62, §179).
 */
const log = (0, logger_js_1.createLogger)('notification-worker');
function isExpiryWarningJob(data) {
    const d = data;
    return (typeof d?.outboundKind === 'string' &&
        typeof d?.subjectId === 'string' &&
        typeof d?.destination === 'string' &&
        (d?.platform === 'telegram' || d?.platform === 'bale' || d?.platform === 'rubika') &&
        typeof d?.channelId === 'string' &&
        typeof d?.channelRef === 'string' &&
        typeof d?.tenantId === 'string' &&
        typeof d?.title === 'string' &&
        typeof d?.body === 'string');
}
function isPasswordResetJob(data) {
    const d = data;
    return d?.kind === 'PASSWORD_RESET' &&
        typeof d?.tenantId === 'string' &&
        typeof d?.email === 'string' &&
        (typeof d?.passwordResetTokenId === 'string' || typeof d?.token === 'string');
}
async function handleExpiryWarning(job) {
    if (!isExpiryWarningJob(job.data)) {
        log.warn({ jobId: job.id }, 'expiry_warning_job_malformed');
        throw new Error('MALFORMED_EXPIRY_WARNING_JOB');
    }
    await (0, delivery_js_1.deliverChannelNotification)(job.data);
}
async function handlePasswordReset(job) {
    if (!isPasswordResetJob(job.data)) {
        log.warn({ jobId: job.id }, 'password_reset_job_malformed');
        throw new Error('MALFORMED_PASSWORD_RESET_JOB');
    }
    const env = (0, env_js_1.loadEnv)();
    const { tenantId, email } = job.data;
    const resetTokenId = job.data.passwordResetTokenId;
    let token = job.data.token;
    if (resetTokenId) {
        token = (await (0, connection_js_1.getRedis)().get(`${delivery_js_1.PASSWORD_RESET_DELIVERY_KEY_PREFIX}${resetTokenId}`)) ?? undefined;
        if (!token) {
            log.warn({
                jobId: job.id,
                tenantId,
                resetTokenId,
                attemptsMade: job.attemptsMade,
            }, 'password_reset_delivery_token_missing_or_expired');
            await (0, delivery_js_1.notifyTenant)({
                tenantId,
                kind: 'PASSWORD_RESET',
                titleFa: 'بازیابی رمز عبور',
                bodyFa: 'درخواست بازیابی رمز عبور شما منقضی شده است. لطفاً دوباره درخواست دهید.',
            }).catch(() => undefined);
            return;
        }
    }
    if (!token) {
        log.warn({ jobId: job.id, tenantId }, 'password_reset_job_missing_token');
        return;
    }
    const resetMessage = (0, templates_js_1.renderEmailTemplate)({
        templateKey: 'password_reset',
        subject: 'بازیابی رمز عبور پُست‌یار',
        preheader: 'برای تعیین رمز عبور جدید از لینک امن زیر استفاده کنید.',
        title: 'بازیابی رمز عبور',
        greeting: 'سلام،',
        paragraphs: [
            'برای تعیین رمز عبور جدید، دکمهٔ زیر را انتخاب کنید. این لینک فقط ۳۰ دقیقه اعتبار دارد و یک‌بار قابل استفاده است.',
            'اگر این درخواست را شما انجام نداده‌اید، این پیام را نادیده بگیرید.',
        ],
        buttonLabel: 'تعیین رمز عبور جدید',
        buttonPath: '/reset-password?token=' + encodeURIComponent(token),
        footerNote: 'لینک بازیابی را با هیچ‌کس به اشتراک نگذارید.',
    }, env.APP_URL, await (0, system_settings_service_js_1.getEmailTemplateSettings)());
    const result = await (0, email_js_1.sendEmail)({
        to: email,
        subject: resetMessage.subject,
        text: resetMessage.text,
        html: resetMessage.html,
    });
    if (!result.ok) {
        log.warn({
            event: 'password_reset_email_failed',
            reason: result.reason ?? 'UNKNOWN',
            tenantId,
            jobId: job.id,
            resetTokenId: resetTokenId ?? null,
            attemptsMade: job.attemptsMade,
        }, 'password_reset_email_failed');
        await (0, delivery_js_1.notifyTenant)({
            tenantId,
            kind: 'PASSWORD_RESET',
            subjectId: resetTokenId,
            titleFa: 'بازیابی رمز عبور',
            bodyFa: 'ارسال راهنمای بازیابی رمز عبور ناموفق بود. لطفاً پس از چند دقیقه دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.',
        }).catch(() => undefined);
        if (resetTokenId && result.reason !== 'NOT_CONFIGURED' && result.reason !== 'DISABLED') {
            // Retain the short-lived token during BullMQ's bounded retries. Throwing
            // activates its configured retry/backoff policy; the opaque job payload
            // still contains no reset secret. Redis TTL is the final cleanup bound.
            throw new Error('PASSWORD_RESET_EMAIL_DELIVERY_FAILED');
        }
        if (resetTokenId)
            await (0, delivery_js_1.deletePasswordResetDeliveryToken)(resetTokenId).catch(() => undefined);
        return;
    }
    log.info({
        tenantId,
        jobId: job.id,
        resetTokenId: resetTokenId ?? null,
    }, 'password_reset_email_accepted_by_smtp');
    if (resetTokenId)
        await (0, delivery_js_1.deletePasswordResetDeliveryToken)(resetTokenId).catch(() => undefined);
}
async function handleEmailNotification(job) {
    if (!(0, templates_js_1.isEmailNotificationPayload)(job.data)) {
        log.warn({ jobId: job.id }, 'email_notification_job_malformed');
        throw new Error('MALFORMED_EMAIL_NOTIFICATION_JOB');
    }
    const rendered = (0, templates_js_1.renderEmailTemplate)(job.data, (0, env_js_1.loadEnv)().APP_URL, await (0, system_settings_service_js_1.getEmailTemplateSettings)());
    const result = await (0, email_js_1.sendEmail)({
        to: job.data.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
    });
    if (!result.ok) {
        log.warn({ jobId: job.id, reason: result.reason ?? 'UNKNOWN' }, 'email_notification_delivery_failed');
        if (result.reason === 'DISABLED' || result.reason === 'NOT_CONFIGURED')
            return;
        throw new Error('EMAIL_NOTIFICATION_DELIVERY_FAILED');
    }
}
async function handleBusinessEmailEvent(job) {
    if (!(0, email_notifications_js_1.isBusinessEmailEvent)(job.data)) {
        log.warn({ jobId: job.id }, 'business_email_event_malformed');
        throw new Error('MALFORMED_BUSINESS_EMAIL_EVENT');
    }
    await (0, email_notifications_js_1.dispatchEmailForBusinessEvent)(job.data);
}
function startNotificationWorker() {
    // createWorker's processor parameter resolves to `never` due to a broken
    // conditional type in queue/connection.ts — bridge it without losing typing.
    const processor = async (job) => {
        try {
            if (job.name === 'expiry-warning') {
                await handleExpiryWarning(job);
            }
            else if (job.name === 'password-reset') {
                await handlePasswordReset(job);
            }
            else if (job.name === 'email-notification') {
                await handleEmailNotification(job);
            }
            else if (job.name === 'business-email-event') {
                await handleBusinessEmailEvent(job);
            }
            else {
                log.error({ jobName: job.name, jobId: job.id }, 'unknown_notification_job');
                throw new Error(`UNKNOWN_NOTIFICATION_JOB: ${job.name}`);
            }
        }
        catch (err) {
            log.error({ err, jobName: job.name, jobId: job.id }, 'notification_job_failed');
            throw err; // BullMQ retry policy applies
        }
    };
    return (0, connection_js_1.createWorker)('notifications', processor, { concurrency: 2 });
}
