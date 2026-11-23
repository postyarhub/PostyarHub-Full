"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZarinpalAdapter = void 0;
const http_js_1 = require("../../core/http.js");
const errors_js_1 = require("../../core/errors.js");
const SANDBOX_BASE = 'https://sandbox.zarinpal.com/pg/v4/payment';
const BASE = 'https://payment.zarinpal.com/pg/v4/payment';
const START_PAY = (authority, sandbox) => sandbox
    ? `https://sandbox.zarinpal.com/pg/StartPay/${authority}`
    : `https://payment.zarinpal.com/pg/StartPay/${authority}`;
class ZarinpalAdapter {
    merchantId;
    sandbox;
    id = 'zarinpal';
    constructor(merchantId, sandbox = false) {
        this.merchantId = merchantId;
        this.sandbox = sandbox;
    }
    async createPayment(input) {
        // Item-13 root-cause fix: an unconfigured merchant used to surface as a
        // generic 500 INTERNAL_ERROR. Degrade gracefully with a stable, actionable
        // Persian code so the frontend can fall back to card-to-card.
        if (!this.merchantId || this.merchantId.trim() === '') {
            throw new errors_js_1.AppError(errors_js_1.ERR.GATEWAY_NOT_CONFIGURED());
        }
        const { data } = await (0, http_js_1.httpJson)(`${this.sandbox ? SANDBOX_BASE : BASE}/request.json`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
                merchant_id: this.merchantId,
                amount: input.amountRial, // ZarinPal amounts are in Rial
                currency: 'IRR',
                description: input.description,
                callback_url: input.callbackUrl,
                ...(input.mobile ? { metadata: { mobile: input.mobile } } : {}),
            }),
            timeoutMs: 20_000,
        }).catch(() => {
            throw new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
        });
        const authority = data?.data?.authority;
        if (!authority)
            throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_VERIFY_FAILED());
        return { authority, redirectUrl: START_PAY(authority, this.sandbox) };
    }
    async verifyPayment(amountRial, authority) {
        const { data } = await (0, http_js_1.httpJson)(`${this.sandbox ? SANDBOX_BASE : BASE}/verify.json`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ merchant_id: this.merchantId, amount: amountRial, authority }),
            timeoutMs: 20_000,
        }).catch(() => {
            throw new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
        });
        const code = data?.data?.code ?? -99;
        if (code === 100 || code === 101) {
            return { ok: true, refId: String(data?.data?.ref_id ?? ''), code };
        }
        return { ok: false, code };
    }
}
exports.ZarinpalAdapter = ZarinpalAdapter;
