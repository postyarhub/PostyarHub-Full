"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOT_WEBHOOK_IP_WINDOW_SECONDS = exports.BOT_WEBHOOK_IP_LIMIT = void 0;
exports.botWebhookIpRateLimitKey = botWebhookIpRateLimitKey;
exports.enforceBotWebhookIpLimit = enforceBotWebhookIpLimit;
const node_crypto_1 = require("node:crypto");
const errors_js_1 = require("../../core/errors.js");
const connection_js_1 = require("../../queue/connection.js");
// Independent of botId: every webhook request from the same resolved client IP
// shares one short-lived Redis bucket, while the existing per-bot limiter remains.
exports.BOT_WEBHOOK_IP_LIMIT = 5000;
exports.BOT_WEBHOOK_IP_WINDOW_SECONDS = 60;
const BOT_WEBHOOK_IP_COUNTER_SCRIPT = [
    'local count = redis.call("INCR", KEYS[1])',
    'if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end',
    'return count',
].join('\n');
function botWebhookIpRateLimitKey(ip) {
    const ipHash = (0, node_crypto_1.createHash)('sha256').update(String(ip || 'unknown')).digest('hex');
    return `postyar:rate-limit:bot-webhook-ip:${ipHash}`;
}
async function enforceBotWebhookIpLimit(req) {
    const key = botWebhookIpRateLimitKey(String(req.ip || 'unknown'));
    let count;
    try {
        count = Number(await (0, connection_js_1.getRedis)().eval(BOT_WEBHOOK_IP_COUNTER_SCRIPT, 1, key, String(exports.BOT_WEBHOOK_IP_WINDOW_SECONDS)));
    }
    catch {
        req.log.error({ requestId: req.id }, 'bot_webhook_ip_rate_limit_unavailable');
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    }
    if (!Number.isSafeInteger(count) || count < 1) {
        req.log.error({ requestId: req.id }, 'bot_webhook_ip_rate_limit_invalid_result');
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    }
    if (count > exports.BOT_WEBHOOK_IP_LIMIT)
        throw new errors_js_1.AppError(errors_js_1.ERR.RATE_LIMITED());
}
