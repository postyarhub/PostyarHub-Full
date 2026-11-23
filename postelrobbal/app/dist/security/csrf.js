"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueCsrfToken = issueCsrfToken;
exports.verifyCsrfToken = verifyCsrfToken;
const node_crypto_1 = require("node:crypto");
const env_js_1 = require("../config/env.js");
/**
 * CSRF double-submit token bound to the session CSRF secret (§59 session contract).
 * Token = base64url(nonce).hmac(nonce+sessionSecret)
 */
function issueCsrfToken(csrfSecret) {
    const nonce = (0, node_crypto_1.randomUUID)().replace(/-/g, '');
    const sig = (0, node_crypto_1.createHmac)('sha256', (0, env_js_1.loadEnv)().CSRF_SECRET).update(`${nonce}.${csrfSecret}`).digest('base64url');
    return `${nonce}.${sig}`;
}
function verifyCsrfToken(token, csrfSecret) {
    if (!token || !token.includes('.'))
        return false;
    const [nonce, sig] = token.split('.');
    if (!nonce || !sig)
        return false;
    const expected = (0, node_crypto_1.createHmac)('sha256', (0, env_js_1.loadEnv)().CSRF_SECRET).update(`${nonce}.${csrfSecret}`).digest('base64url');
    try {
        return (0, node_crypto_1.timingSafeEqual)(Buffer.from(sig), Buffer.from(expected));
    }
    catch {
        return false;
    }
}
