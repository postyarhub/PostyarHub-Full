"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEmailDeliveryConfigured = isEmailDeliveryConfigured;
exports.sendEmail = sendEmail;
const nodemailer_1 = __importDefault(require("nodemailer"));
const env_js_1 = require("../../config/env.js");
const logger_js_1 = require("../../core/logger.js");
const system_settings_service_js_1 = require("../../modules/admin/system-settings.service.js");
const log = (0, logger_js_1.createLogger)('email-provider');
const SMTP_TIMEOUT_MS = 20_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
async function runtimeMailConfig() {
    const settings = await (0, system_settings_service_js_1.getEmailSettings)();
    if (!settings.enabled)
        return { reason: 'DISABLED' };
    const env = (0, env_js_1.loadEnv)();
    // Treat database SMTP settings as one atomic configuration. Never combine
    // credentials from an unrelated legacy .env sender with a newly entered host.
    const useSettings = Boolean(settings.host.trim());
    const host = useSettings ? settings.host.trim() : (env.MAIL_HOST ?? '').trim();
    const port = useSettings ? settings.port : (env.MAIL_PORT ?? settings.port);
    const user = useSettings ? settings.user.trim() : (env.MAIL_USER ?? '').trim();
    const pass = useSettings ? settings.pass : (env.MAIL_PASSWORD ?? '');
    if (!host || !user || !pass)
        return { reason: 'NOT_CONFIGURED' };
    const secure = port === 465 ? true : port === 587 ? false : settings.secure;
    return {
        config: {
            host,
            port,
            secure,
            user,
            pass,
            fromName: settings.fromName.trim() || 'پُست‌یار',
            fromEmail: (useSettings ? settings.fromEmail.trim() : '').trim() || user,
        },
    };
}
async function isEmailDeliveryConfigured() {
    const result = await runtimeMailConfig();
    return 'config' in result;
}
async function sendEmail(input) {
    if (!input.to || input.to.length > 190 || !EMAIL_RE.test(input.to) || /[\r\n]/.test(input.to)) {
        return { ok: false, reason: 'INVALID_RECIPIENT' };
    }
    const subject = input.subject.trim().replace(/[\r\n]+/g, ' ').slice(0, 190);
    if (!subject || (!input.text && !input.html) || input.text.length > 200_000 || (input.html?.length ?? 0) > 500_000) {
        return { ok: false, reason: 'INVALID_MESSAGE' };
    }
    let result;
    try {
        result = await runtimeMailConfig();
    }
    catch {
        log.warn({ reason: 'EMAIL_CONFIGURATION_UNAVAILABLE' }, 'email_configuration_unavailable');
        return { ok: false, reason: 'EMAIL_CONFIGURATION_UNAVAILABLE' };
    }
    if (!('config' in result))
        return { ok: false, reason: result.reason };
    const config = result.config;
    const transport = nodemailer_1.default.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        requireTLS: !config.secure,
        auth: { user: config.user, pass: config.pass },
        tls: { minVersion: 'TLSv1.2' },
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: 10_000,
        socketTimeout: SMTP_TIMEOUT_MS,
    });
    try {
        const info = await transport.sendMail({
            from: { name: config.fromName, address: config.fromEmail },
            to: input.to,
            subject,
            text: input.text,
            ...(input.html ? { html: input.html } : {}),
        });
        if (!Array.isArray(info.accepted) || info.accepted.length === 0 || (Array.isArray(info.rejected) && info.rejected.length > 0)) {
            return { ok: false, reason: 'SMTP_RECIPIENT_REJECTED' };
        }
        return { ok: true };
    }
    catch (err) {
        const code = typeof err?.code === 'string'
            ? String(err.code).replace(/[^A-Z0-9_-]/gi, '').slice(0, 40)
            : 'SMTP_ERROR';
        log.warn({ reason: code || 'SMTP_ERROR' }, 'email_send_failed');
        return { ok: false, reason: code || 'SMTP_ERROR' };
    }
    finally {
        transport.close();
    }
}
