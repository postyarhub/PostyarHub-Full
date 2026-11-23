"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdpayAdapter = void 0;
const http_js_1 = require("../../core/http.js");
const errors_js_1 = require("../../core/errors.js");
const ids_js_1 = require("../../core/ids.js");
/**
 * IDPay payment gateway adapter (admin-panel v2 gateway settings).
 *
 * Amounts are in RIAL — matches the platform's amountRial convention, so values
 * pass through unchanged (same as ZarinpalAdapter). Sandbox mode is selected
 * with the X-SANDBOX header and still requires a panel-issued API key.
 * Real verification is server-to-server (§117).
 */
const BASE = 'https://api.idpay.ir/v1.1';
class IdpayAdapter {
    apiKey;
    sandbox;
    id = 'idpay';
    constructor(apiKey, sandbox = false) {
        this.apiKey = apiKey;
        this.sandbox = sandbox;
    }
    credential() {
        return this.apiKey.trim();
    }
    async createPayment(input) {
        const apiKey = this.credential();
        if (!apiKey) {
            throw new errors_js_1.AppError(errors_js_1.ERR.GATEWAY_NOT_CONFIGURED());
        }
        const { data } = await (0, http_js_1.httpJson)(`${BASE}/payment`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json',
                'X-API-KEY': apiKey,
                'X-SANDBOX': this.sandbox ? 'true' : 'false',
            },
            body: JSON.stringify({
                order_id: (0, ids_js_1.newId)(),
                amount: input.amountRial, // IDPay amounts are in Rial
                callback: input.callbackUrl,
                ...(input.description ? { desc: input.description.slice(0, 255) } : {}),
            }),
            timeoutMs: 20_000,
        }).catch(() => {
            throw new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
        });
        if (!data?.id || !data.link) {
            throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_VERIFY_FAILED());
        }
        return { authority: data.id, redirectUrl: data.link };
    }
    async verifyPayment(amountRial, authority) {
        if (!Number.isSafeInteger(amountRial) || amountRial <= 0)
            return { ok: false, code: -99 };
        const apiKey = this.credential();
        if (!apiKey) {
            throw new errors_js_1.AppError(errors_js_1.ERR.GATEWAY_NOT_CONFIGURED());
        }
        const { data } = await (0, http_js_1.httpJson)(`${BASE}/payment/verify`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json',
                'X-API-KEY': apiKey,
                'X-SANDBOX': this.sandbox ? 'true' : 'false',
            },
            body: JSON.stringify({ id: authority }),
            timeoutMs: 20_000,
        }).catch(() => {
            throw new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
        });
        const code = data?.status ?? -99;
        // 100 = verified; 101 = already verified (idempotent re-verify)
        if (code === 100 || code === 101) {
            // Verify the transaction amount as well as its ID/status. If IDPay omits
            // the amount or reports a different Rial value, do not settle the payment.
            const verifiedAmount = Number(data?.amount);
            if (!Number.isSafeInteger(verifiedAmount) || verifiedAmount !== amountRial) {
                return { ok: false, code: -98 };
            }
            return { ok: true, refId: String(data?.track_id ?? ''), code };
        }
        return { ok: false, code };
    }
}
exports.IdpayAdapter = IdpayAdapter;
