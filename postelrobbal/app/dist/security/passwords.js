"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.passwordPolicyOk = passwordPolicyOk;
const argon2_1 = __importDefault(require("argon2"));
/** Argon2id (§39). Reference used weak bcrypt/md5 variants — not carried over. */
async function hashPassword(password) {
    return argon2_1.default.hash(password, { type: argon2_1.default.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}
async function verifyPassword(hash, password) {
    try {
        return await argon2_1.default.verify(hash, password);
    }
    catch {
        return false;
    }
}
function passwordPolicyOk(password) {
    return password.length >= 8 && /[a-zA-Z\u0600-\u06FF]/.test(password) && /\d/.test(password);
}
