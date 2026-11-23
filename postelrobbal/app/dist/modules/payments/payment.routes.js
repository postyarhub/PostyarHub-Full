"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPaymentRoutes = registerPaymentRoutes;
const zod_1 = require("zod");
const errors_js_1 = require("../../core/errors.js");
const env_js_1 = require("../../config/env.js");
const payment_service_js_1 = require("./payment.service.js");
const payment_service_js_2 = require("./payment.service.js");
const validation_js_1 = require("../../core/validation.js");
const media_service_js_1 = require("../media/media.service.js");
function auth(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return { id: req.user.id };
}
const topupSchema = zod_1.z.object({
    amountRial: zod_1.z.coerce.number().int().min(100_000).max(2_000_000_000),
    method: zod_1.z.enum(['online', 'card_to_card']).optional(),
});
const intentSchema = zod_1.z.object({
    kind: zod_1.z.literal('subscription'),
    planId: zod_1.z.string().min(1).max(64),
    method: zod_1.z.enum(['online', 'card_to_card', 'wallet']),
    months: zod_1.z.coerce.number().int().min(1).max(12).optional(),
});
const RECEIPT_MIME_ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
const ulidish = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
async function registerPaymentRoutes(app) {
    // Authenticated payment methods used by the dashboard checkout.
    app.get('/payments/methods', { preHandler: [app.requireAuth] }, async () => {
        const { getPaymentSettings } = await import('./payment-settings.service.js');
        const settings = await getPaymentSettings();
        return {
            success: true,
            data: {
                onlineEnabled: settings.onlineEnabled,
                provider: settings.provider,
                cardToCardEnabled: settings.cardToCardEnabled,
                cards: settings.cards.map((c) => ({ id: c.id, bankName: c.bankName, cardNumber: c.cardNumber, holderName: c.holderName })),
            },
        };
    });
    app.post('/payments/wallet-topup', { preHandler: [app.requireAuth], config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req) => req.user?.id ?? req.ip } } }, async (req) => {
        const input = parse(topupSchema, req.body);
        const result = await (0, payment_service_js_1.createWalletTopup)(auth(req).id, input.amountRial, input.method);
        return { success: true, data: result };
    });
    // Unified purchase intent (contract 14-contract item 3):
    //   online       → {paymentId, redirectUrl} (existing Zarinpal path)
    //   card_to_card → {paymentId, reference, cards}  (admin-reviewed receipt)
    app.post('/payments/intent', { preHandler: [app.requireAuth], config: { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: (req) => req.user?.id ?? req.ip } } }, async (req) => {
        const input = parse(intentSchema, req.body);
        const result = await (0, payment_service_js_2.createSubscriptionIntent)(auth(req).id, input);
        return { success: true, data: result };
    });
    // Card-to-card receipt upload (multipart "file" ≤5MB, JPG/PNG/WebP/PDF,
    // magic-byte verified, private storage). Payment must belong to the caller.
    app.post('/payments/:id/receipt', { preHandler: [app.requireAuth], config: { rateLimit: { max: 10, timeWindow: '1 hour', keyGenerator: (req) => req.user?.id ?? req.ip } } }, async (req) => {
        const me = auth(req);
        const { id } = req.params;
        if (!ulidish.test(id))
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('شناسه معتبر نیست.'));
        if (!req.isMultipart()) {
            throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_RECEIPT_INVALID('ارسال رسید باید به‌صورت multipart با فیلد «file» انجام شود.'));
        }
        let filePart = null;
        let note = null;
        for await (const part of req.parts()) {
            if (part.type === 'file') {
                if (filePart)
                    continue; // multipart limit is files:1 — defensive
                const mime = part.mimetype.toLowerCase();
                if (!RECEIPT_MIME_ALLOWED.has(mime)) {
                    throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_RECEIPT_INVALID('فرمت فایل مجاز نیست. تصویر (JPG، PNG، WebP) یا PDF ارسال کنید.'));
                }
                let buffer;
                try {
                    buffer = await part.toBuffer();
                }
                catch {
                    throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_RECEIPT_INVALID('حجم فایل بیش از حد مجاز است.'));
                }
                if (buffer.length > RECEIPT_MAX_BYTES) {
                    throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_RECEIPT_INVALID('حجم فایل باید حداکثر ۵ مگابایت باشد.'));
                }
                filePart = { buffer, mime };
            }
            else if (part.fieldname === 'note' && typeof part.value === 'string') {
                note = part.value;
            }
        }
        if (!filePart)
            throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_RECEIPT_INVALID('فایلی ارسال نشده است.'));
        // uploadMedia re-validates size + declared-vs-actual magic bytes.
        const media = await (0, media_service_js_1.uploadMedia)(me.id, {
            buffer: filePart.buffer,
            mimeType: filePart.mime,
            maxBytes: RECEIPT_MAX_BYTES,
        });
        const result = await (0, payment_service_js_2.attachReceipt)(me.id, id, { mediaId: media.id, note });
        return { success: true, data: result };
    });
    // Payment history (no authority/gateway refs exposed)
    app.get('/payments', { preHandler: [app.requireAuth] }, async (req) => {
        const q = (req.query ?? {});
        const page = Number.parseInt(q.page ?? '1', 10) || 1;
        const pageSize = Number.parseInt(q.pageSize ?? '20', 10) || 20;
        const data = await (0, payment_service_js_2.listPayments)(auth(req).id, page, pageSize);
        return { success: true, data };
    });
    /**
     * Gateway return (PUBLIC, CSRF-exempt — buildApp skips /api/v1/payments/callback).
     * Never returns JSON to a browser: always 302 back to the dashboard.
     */
    const gatewayCallback = async (req, reply) => {
        const env = (0, env_js_1.loadEnv)();
        const query = (req.query ?? {});
        const body = (req.body ?? {});
        const value = (key) => {
            const raw = body[key] ?? query[key];
            if (Array.isArray(raw))
                return typeof raw[0] === 'string' ? raw[0] : undefined;
            return typeof raw === 'string' ? raw : undefined;
        };
        const paymentId = value('paymentId') ?? value('InvoiceID') ?? '';
        if (!paymentId) {
            return reply.redirect(`${env.APP_URL}/payment/result?payment=failed`);
        }
        const result = await (0, payment_service_js_1.handleCallback)({
            paymentId,
            Authority: value('Authority'),
            Status: value('Status') ?? value('PaymentStatus'),
            trackId: value('trackId'),
            id: value('id'),
            status: value('status'),
        });
        const flag = result.ok ? 'ok' : 'failed';
        return reply.redirect(`${env.APP_URL}/dashboard/wallet?payment=${flag}`);
    };
    app.get('/payments/callback', { config: { rateLimit: { max: 120, timeWindow: '15 minutes' } } }, gatewayCallback);
    app.post('/payments/callback', { config: { rateLimit: { max: 120, timeWindow: '15 minutes' } } }, gatewayCallback);
}
