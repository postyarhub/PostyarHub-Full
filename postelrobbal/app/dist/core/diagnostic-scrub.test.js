"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const diagnostic_scrub_js_1 = require("./diagnostic-scrub.js");
(0, vitest_1.describe)('safe internal error diagnostics', () => {
    (0, vitest_1.it)('redacts URL credentials, authorization headers and secret-like key/value pairs', () => {
        const result = (0, diagnostic_scrub_js_1.sanitizeDiagnosticText)('failed https://api-user:urlSecret@example.test/path Authorization: Bearer headerSecret password=messageSecret access_token=querySecret api_key=keySecret');
        (0, vitest_1.expect)(result).toContain('https://[REDACTED]@example.test/path');
        (0, vitest_1.expect)(result).toContain('Authorization: [REDACTED]');
        (0, vitest_1.expect)(result).not.toContain('urlSecret');
        (0, vitest_1.expect)(result).not.toContain('headerSecret');
        (0, vitest_1.expect)(result).not.toContain('messageSecret');
        (0, vitest_1.expect)(result).not.toContain('querySecret');
        (0, vitest_1.expect)(result).not.toContain('keySecret');
    });
    (0, vitest_1.it)('never returns the raw stack, even when the stack contains secrets', () => {
        const error = new Error('request failed password=messageSecret');
        error.stack = 'Error: https://user:stackUrlSecret@example.test/?refresh_token=stackTokenSecret password=stackPasswordSecret';
        const fields = (0, diagnostic_scrub_js_1.safeInternalErrorFields)(error);
        const serialized = JSON.stringify(fields);
        (0, vitest_1.expect)(fields.stackPresent).toBe(true);
        (0, vitest_1.expect)(fields.errorMessage).toContain('password=[REDACTED]');
        (0, vitest_1.expect)(serialized).not.toContain('stackUrlSecret');
        (0, vitest_1.expect)(serialized).not.toContain('stackTokenSecret');
        (0, vitest_1.expect)(serialized).not.toContain('stackPasswordSecret');
        (0, vitest_1.expect)(serialized).not.toContain('messageSecret');
    });
    (0, vitest_1.it)('bounds diagnostic text to a safe maximum length', () => {
        (0, vitest_1.expect)((0, diagnostic_scrub_js_1.sanitizeDiagnosticText)('x'.repeat(5000), 200)).toHaveLength(200);
        (0, vitest_1.expect)((0, diagnostic_scrub_js_1.sanitizeDiagnosticText)('x'.repeat(5000), 5000)).toHaveLength(1200);
    });
});
