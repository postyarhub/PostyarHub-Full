"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptSecret = encryptSecret;
exports.decryptSecret = decryptSecret;
exports.maskSecret = maskSecret;
const node_crypto_1 = require("node:crypto");
const env_js_1 = require("../config/env.js");
/**
 * AES-256-GCM at-rest encryption for provider credentials (§92).
 * Output: v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>
 */
function key() {
    return Buffer.from((0, env_js_1.loadEnv)().ENCRYPTION_KEY, 'hex');
}
function encryptSecret(plain) {
    const iv = (0, node_crypto_1.randomBytes)(12);
    const cipher = (0, node_crypto_1.createCipheriv)('aes-256-gcm', key(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}
function decryptSecret(payload) {
    const [version, ivB, tagB, dataB] = payload.split('.');
    if (version !== 'v1' || !ivB || !tagB || !dataB)
        throw new Error('ENCRYPTION_FORMAT_INVALID');
    const decipher = (0, node_crypto_1.createDecipheriv)('aes-256-gcm', key(), Buffer.from(ivB, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64url')), decipher.final()]).toString('utf8');
}
/** Masking for API responses: never return full credentials (§93). */
function maskSecret(secret) {
    if (secret.length <= 8)
        return '****';
    return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}
