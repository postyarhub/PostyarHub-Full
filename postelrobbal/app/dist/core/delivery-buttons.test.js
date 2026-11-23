"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const delivery_buttons_js_1 = require("./delivery-buttons.js");
const platforms = ['telegram', 'bale', 'rubika'];
(0, vitest_1.describe)('delivery button forward compatibility', () => {
    vitest_1.it.each(platforms)('deduplicates duplicate URL representations in legacy mode for %s', (platform) => {
        const buttons = (0, delivery_buttons_js_1.resolveUniqueDeliveryButtons)(platform, [
            { label: 'سایت', url: 'https://example.com/help' },
            { label: 'راهنما', target: { type: 'URL', value: 'https://example.com/help' } },
            { label: 'سایت قدیمی', url: 'https://example.com/help' },
            { label: 'کانال', target: { type: platform === 'telegram' ? 'TELEGRAM_ID' : platform === 'bale' ? 'BALE_ID' : 'RUBIKA_ID', value: 'postyar' } },
        ]);
        (0, vitest_1.expect)(buttons).toHaveLength(2);
        (0, vitest_1.expect)(buttons[0]).toEqual({ label: 'سایت', url: 'https://example.com/help' });
    });
    vitest_1.it.each(['telegram', 'bale'])('omits non-URL legacy actions that prevent forwarded keyboards on %s', (platform) => {
        const buttons = (0, delivery_buttons_js_1.resolveUniqueDeliveryButtons)(platform, [
            { label: 'سایت', url: 'https://example.com/help' },
            { label: 'عملیات قدیمی', callback: 'legacy-action' },
            { label: 'دکمه بدون مقصد' },
            { label: 'شماره قدیمی', url: 'tel:+989121234567' },
            { label: 'کانال', target: { type: 'URL', value: 'https://example.com/channel' } },
        ]);
        (0, vitest_1.expect)(buttons).toEqual([
            { label: 'سایت', url: 'https://example.com/help' },
            { label: 'کانال', url: 'https://example.com/channel' },
        ]);
        (0, vitest_1.expect)(buttons.every((button) => typeof button.url === 'string' && button.url.length > 0)).toBe(true);
    });
    (0, vitest_1.it)('resolves Telegram phone buttons to a forward-compatible HTTPS URL', () => {
        const buttons = (0, delivery_buttons_js_1.resolveUniqueDeliveryButtons)('telegram', [
            { label: 'تماس', target: { type: 'PHONE', value: '+989121234567' } },
        ]);
        (0, vitest_1.expect)(buttons).toEqual([
            { label: 'تماس', url: 'https://postyarhub.ir/api/v1/public/phone/989121234567' },
        ]);
    });
    (0, vitest_1.it)('keeps Rubika callback actions because Rubika uses a native inline keypad', () => {
        const buttons = (0, delivery_buttons_js_1.resolveUniqueDeliveryButtons)('rubika', [
            { label: 'راهنما', callback: 'help' },
            { label: 'کانال', url: 'https://rubika.ir/postyar' },
        ]);
        (0, vitest_1.expect)(buttons).toEqual([
            { label: 'راهنما', callback: 'help' },
            { label: 'کانال', url: 'https://rubika.ir/postyar' },
        ]);
    });
    (0, vitest_1.it)('deduplicates a URL carried in both legacy arrays without consuming the button limit', () => {
        const buttons = (0, delivery_buttons_js_1.resolveUniqueDeliveryButtons)('telegram', [
            { label: 'A', url: 'https://example.com/a' },
            { label: 'A old shape', url: 'https://example.com/a' },
            { label: 'B', url: 'https://example.com/b' },
            { label: 'C', url: 'https://example.com/c' },
        ], 3);
        (0, vitest_1.expect)(buttons.map((button) => button.url)).toEqual([
            'https://example.com/a',
            'https://example.com/b',
            'https://example.com/c',
        ]);
    });
});
