"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const delivery_state_js_1 = require("./delivery-state.js");
(0, vitest_1.describe)('delivery state machine', () => {
    (0, vitest_1.it)('allows only the intended terminal/retry transitions', () => {
        (0, vitest_1.expect)((0, delivery_state_js_1.canTransition)('PENDING', 'PROCESSING')).toBe(true);
        (0, vitest_1.expect)((0, delivery_state_js_1.canTransition)('PROCESSING', 'SENT')).toBe(true);
        (0, vitest_1.expect)((0, delivery_state_js_1.canTransition)('PROCESSING', 'RETRYING')).toBe(true);
        (0, vitest_1.expect)((0, delivery_state_js_1.canTransition)('SENT', 'PROCESSING')).toBe(false);
        (0, vitest_1.expect)((0, delivery_state_js_1.canTransition)('CANCELLED', 'PENDING')).toBe(false);
        (0, vitest_1.expect)(() => (0, delivery_state_js_1.assertTransition)('SENT', 'PROCESSING')).toThrow();
    });
    (0, vitest_1.it)('uses bounded retry delays and stops at the max attempt count', () => {
        (0, vitest_1.expect)((0, delivery_state_js_1.nextRetryDelaySeconds)(1)).toBe(30);
        (0, vitest_1.expect)((0, delivery_state_js_1.nextRetryDelaySeconds)(2)).toBe(120);
        (0, vitest_1.expect)((0, delivery_state_js_1.nextRetryDelaySeconds)(3)).toBe(600);
        (0, vitest_1.expect)((0, delivery_state_js_1.nextRetryDelaySeconds)(4)).toBe(1800);
        (0, vitest_1.expect)((0, delivery_state_js_1.nextRetryDelaySeconds)(5)).toBeNull();
        (0, vitest_1.expect)((0, delivery_state_js_1.nextRetryDelaySeconds)(6)).toBeNull();
    });
});
