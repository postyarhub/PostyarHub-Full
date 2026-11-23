"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZibalAdapter = void 0;
const http_js_1 = require("../../core/http.js");
const errors_js_1 = require("../../core/errors.js");
/**
 * Zibal payment gateway adapter (admin-panel v2 gateway settings).
 *
 * Zibal amounts are in RIAL — matches the platform's amountRial convention, so
 * values pass through unchanged (same as ZarinpalAdapter). Zibal uses a single
 * gateway host for both modes: the sandbox is selected by the merchant value,
 * whose well-known public test merchant is the literal string 'zibal'.
 * Real verification is server-to-server (§117).
 */
const BASE = 'https://gateway.zibal.ir/v1';
const START_PAY = 'https://gateway.zibal.ir/start';
class ZibalAdapter {
    merchantId;
    sandbox;
    id = 'zibal';
    constructor(merchantId, sandbox = false) {
        this.merchantId = merchantId;
        this.sandbox = sandbox;
    }
    /** Sandbox with no configured merchant degrades to the public test merchant. */
    merchant() {
        if ((!this.merchantId || this.merchantId.trim() === '') && this.sandbox)
            return 'zibal';
        return this.merchantId.trim();
    }
    async createPayment(input) {
        const merchant = this.merchant();
        if (!merchant) {
            throw new errors_js_1.AppError(errors_js_1.ERR.GATEWAY_NOT_CONFIGURED());
        }
        const { data } = await (0, http_js_1.httpJson)(`${BASE}/request`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
                merchant,
                amount: input.amountRial, // Zibal amounts are in Rial
                callbackUrl: input.callbackUrl,
                description: input.description,
                ...(input.mobile ? { mobile: input.mobile } : {}),
            }),
            timeoutMs: 20_000,
        }).catch(() => {
            throw new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
        });
        // tracked === 100 means the request was accepted; anything else is a
        // gateway-side rejection (invalid merchant, blocked account, ...).
        if (data?.tracked !== 100 || !data.trackId) {
            throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_VERIFY_FAILED());
        }
        return {
            authority: String(data.trackId),
            redirectUrl: `${START_PAY}/${data.trackId}`,
        };
    }
    async verifyPayment(amountRial, authority) {
        if (!Number.isSafeInteger(amountRial) || amountRial <= 0)
            return { ok: false, code: -99 };
        const merchant = this.merchant();
        if (!merchant) {
            throw new errors_js_1.AppError(errors_js_1.ERR.GATEWAY_NOT_CONFIGURED());
        }
        const { data } = await (0, http_js_1.httpJson)(`${BASE}/verify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ merchant, trackId: Number(authority) }),
            timeoutMs: 20_000,
        }).catch(() => {
            throw new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
        });
        const code = data?.result ?? -99;
        // 100 = verified; 201 = already verified (idempotent re-verify)
        if (code === 100 || code === 201) {
            // A valid transaction id alone is not sufficient: fail closed if the
            // provider does not return the amount or if its unit/value differs.
            const verifiedAmount = Number(data?.amount);
            if (!Number.isSafeInteger(verifiedAmount) || verifiedAmount !== amountRial) {
                return { ok: false, code: -98 };
            }
            return { ok: true, refId: String(data?.refNumber ?? ''), code };
        }
        return { ok: false, code };
    }
}
exports.ZibalAdapter = ZibalAdapter;
