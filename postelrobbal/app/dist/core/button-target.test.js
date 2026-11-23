"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const button_target_js_1 = require("./button-target.js");
(0, vitest_1.describe)('typed publishing button targets', () => {
    (0, vitest_1.it)('maps explicit platform IDs independently of delivery platform', () => {
        (0, vitest_1.expect)((0, button_target_js_1.resolveButtonTargetUrl)('telegram', { type: 'TELEGRAM_ID', value: '@postyar' })).toBe('https://t.me/postyar');
        (0, vitest_1.expect)((0, button_target_js_1.resolveButtonTargetUrl)('telegram', { type: 'BALE_ID', value: '@postyar' })).toBe('https://ble.ir/postyar');
        (0, vitest_1.expect)((0, button_target_js_1.resolveButtonTargetUrl)('bale', { type: 'RUBIKA_ID', value: '@postyar' })).toBe('https://rubika.ir/postyar');
    });
    (0, vitest_1.it)('normalizes bare website addresses to https and preserves http(s)', () => {
        (0, vitest_1.expect)((0, button_target_js_1.normalizeButtonWebUrl)('postyarhub.ir/help')).toBe('https://postyarhub.ir/help');
        (0, vitest_1.expect)((0, button_target_js_1.normalizeButtonWebUrl)('https://example.com/a?x=1')).toBe('https://example.com/a?x=1');
        (0, vitest_1.expect)((0, button_target_js_1.resolveButtonTargetUrl)('bale', { type: 'URL', value: 'http://example.com' })).toBe('http://example.com');
    });
    (0, vitest_1.it)('normalizes platform IDs without requiring @', () => {
        (0, vitest_1.expect)((0, button_target_js_1.normalizeButtonTargetValue)('TELEGRAM_ID', '@postyar')).toBe('postyar');
        (0, vitest_1.expect)((0, button_target_js_1.normalizeButtonTargetValue)('BALE_ID', 'postyar')).toBe('postyar');
        (0, vitest_1.expect)((0, button_target_js_1.normalizeButtonTargetValue)('RUBIKA_ID', '@postyar')).toBe('postyar');
    });
    (0, vitest_1.it)('validates phone input and uses the HTTPS bridge on every platform', () => {
        (0, vitest_1.expect)((0, button_target_js_1.normalizeButtonTargetValue)('PHONE', '+98 912-123-4567')).toBe('+989121234567');
        (0, vitest_1.expect)((0, button_target_js_1.resolveButtonTargetUrl)('telegram', { type: 'PHONE', value: '+989121234567' })).toBe('https://postyarhub.ir/api/v1/public/phone/989121234567');
        (0, vitest_1.expect)((0, button_target_js_1.resolveButtonTargetUrl)('bale', { type: 'PHONE', value: '+989121234567' })).toBe('https://postyarhub.ir/api/v1/public/phone/989121234567');
        (0, vitest_1.expect)((0, button_target_js_1.resolveButtonTargetUrl)('rubika', { type: 'PHONE', value: '+989121234567' })).toBe('https://postyarhub.ir/api/v1/public/phone/989121234567');
    });
    (0, vitest_1.it)('keeps legacy USERNAME routing functional', () => {
        (0, vitest_1.expect)((0, button_target_js_1.resolveButtonTargetUrl)('telegram', { type: 'USERNAME', value: '@postyar' })).toBe('https://t.me/postyar');
        (0, vitest_1.expect)((0, button_target_js_1.resolveButtonTargetUrl)('bale', { type: 'USERNAME', value: '@postyar' })).toBe('https://ble.ir/postyar');
        (0, vitest_1.expect)((0, button_target_js_1.resolveButtonTargetUrl)('rubika', { type: 'USERNAME', value: '@postyar' })).toBe('https://rubika.ir/postyar');
    });
});
