"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newToken = exports.newId = void 0;
exports.sha256Hex = sha256Hex;
exports.timingSafeEqualStr = timingSafeEqualStr;
const ulid_1 = require("ulid");
const node_crypto_1 = require("node:crypto");
/** Opaque, sortable public identifiers (§172: minimize internal id exposure). */
const newId = () => (0, ulid_1.ulid)();
exports.newId = newId;
const newToken = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
exports.newToken = newToken;
async function sha256Hex(input) {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Buffer.from(digest).toString('hex');
}
function timingSafeEqualStr(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length)
        return false;
    return (0, node_crypto_1.timingSafeEqual)(ab, bb);
}
