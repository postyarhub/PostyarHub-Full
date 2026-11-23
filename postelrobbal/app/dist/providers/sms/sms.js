"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSms = sendSms;
const env_js_1 = require("../../config/env.js");
const logger_js_1 = require("../../core/logger.js");
const http_js_1 = require("../../core/http.js");
/**
 * SMS adapter (honest v1, §27). Without SMS_API_KEY the send is reported as
 * NOT_CONFIGURED — never a fake success. With a key, a kavenegar-compatible
 * HTTP API is called (fixed provider host → SSRF guard not required).
 */
const log = (0, logger_js_1.createLogger)('sms-provider');
const KAVENEGAR_BASE = 'https://api.kavenegar.com/v1';
async function sendSms(input) {
    const env = (0, env_js_1.loadEnv)();
    if (!env.SMS_API_KEY) {
        log.warn({ event: 'sms_queued_unconfigured' }, 'sms_queued_unconfigured');
        return { ok: false, reason: 'NOT_CONFIGURED' };
    }
    const url = `${KAVENEGAR_BASE}/${encodeURIComponent(env.SMS_API_KEY)}/sms/send.json?receptor=${encodeURIComponent(input.to)}&message=${encodeURIComponent(input.message.slice(0, 400))}`;
    try {
        const { status, data } = await (0, http_js_1.httpJson)(url, { timeoutMs: 15_000 });
        const apiStatus = data?.return?.status ?? status;
        if (status === 200 && apiStatus === 200) {
            return { ok: true };
        }
        const reason = `SMS_PROVIDER_STATUS_${apiStatus ?? 'UNKNOWN'}`;
        log.warn({ event: 'sms_send_failed', reason }, 'sms_send_failed');
        return { ok: false, reason };
    }
    catch (err) {
        const reason = err instanceof Error ? err.message.slice(0, 120) : 'SMS_ERROR';
        log.warn({ event: 'sms_send_failed', reason }, 'sms_send_failed');
        return { ok: false, reason };
    }
}
