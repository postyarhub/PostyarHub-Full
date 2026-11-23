"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const vitest_1 = require("vitest");
const redisState = vitest_1.vi.hoisted(() => ({
    values: new Map(),
    counts: new Map(),
}));
vitest_1.vi.mock('../queue/connection.js', () => ({
    getRedis: () => ({
        eval: async (_script, _keyCount, key, ttl) => {
            const next = (redisState.counts.get(key) ?? 0) + 1;
            redisState.counts.set(key, next);
            return next;
        },
        set: async (key, value, _expiryMode, ttl, nx) => {
            const current = redisState.values.get(key);
            if (current && current.expiresAt > Date.now())
                return null;
            redisState.values.set(key, { value, expiresAt: Date.now() + Number(ttl) * 1000 });
            return 'OK';
        },
    }),
}));
const captcha_js_1 = require("./captcha.js");
const TEST_SECRET = 'postyar-captcha-regression-secret-2026-10-14';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function expectedAnswer(captchaId, binding) {
    const key = (0, node_crypto_1.createHash)('sha256').update(TEST_SECRET).digest();
    const bindingDigest = (0, node_crypto_1.createHash)('sha256').update(String(binding || '')).digest('hex');
    const digest = (0, node_crypto_1.createHmac)('sha256', key)
        .update(`postyar-captcha:v3:${captchaId}:${bindingDigest}`)
        .digest();
    return Array.from({ length: 5 }, (_, i) => ALPHABET[(digest[i] ?? 0) % ALPHABET.length] ?? 'A').join('');
}
(0, vitest_1.beforeEach)(() => {
    process.env.CSRF_SECRET = TEST_SECRET;
    redisState.values.clear();
    redisState.counts.clear();
});
(0, vitest_1.describe)('CAPTCHA anti-automation controls', () => {
    (0, vitest_1.it)('consumes a challenge on the first failed verification attempt', async () => {
        const binding = `failed-attempt-${Date.now()}-${Math.random()}`;
        const challenge = (0, captcha_js_1.issueCaptcha)(binding);
        const answer = expectedAnswer(challenge.captchaId, binding);
        const wrong = answer === 'AAAAA' ? 'BBBBB' : 'AAAAA';
        (0, vitest_1.expect)(await (0, captcha_js_1.verifyCaptcha)(challenge.captchaId, wrong, binding)).toBe(false);
        (0, vitest_1.expect)(await (0, captcha_js_1.verifyCaptcha)(challenge.captchaId, answer, binding)).toBe(false);
    });
    (0, vitest_1.it)('accepts a valid challenge only once', async () => {
        const binding = `valid-attempt-${Date.now()}-${Math.random()}`;
        const challenge = (0, captcha_js_1.issueCaptcha)(binding);
        const answer = expectedAnswer(challenge.captchaId, binding);
        (0, vitest_1.expect)(await (0, captcha_js_1.verifyCaptcha)(challenge.captchaId, answer, binding)).toBe(true);
        (0, vitest_1.expect)(await (0, captcha_js_1.verifyCaptcha)(challenge.captchaId, answer, binding)).toBe(false);
    });
    (0, vitest_1.it)('limits challenge issuance by a shared binding bucket', async () => {
        const binding = `issuance-test-${Date.now()}-${Math.random()}`;
        for (let i = 0; i < 30; i += 1)
            (0, vitest_1.expect)(await (0, captcha_js_1.consumeCaptchaIssuanceSlot)(binding)).toBe(true);
        (0, vitest_1.expect)(await (0, captcha_js_1.consumeCaptchaIssuanceSlot)(binding)).toBe(false);
    });
});
