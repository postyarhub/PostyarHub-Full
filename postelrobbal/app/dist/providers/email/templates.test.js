"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const templates_js_1 = require("./templates.js");
(0, vitest_1.describe)('Postyar email template', () => {
    (0, vitest_1.it)('escapes dynamic content instead of interpreting user-controlled HTML', () => {
        const rendered = (0, templates_js_1.renderEmailTemplate)({
            subject: 'پیام پُست‌یار',
            preheader: 'آزمایش',
            title: '<script>alert(1)</script>',
            greeting: 'سلام <b>',
            paragraphs: ['متن & <img src=x onerror=alert(1)>'],
            details: [{ label: 'عنوان', value: 'الف "ب"' }],
        }, 'https://postyarhub.ir');
        (0, vitest_1.expect)(rendered.html).toContain('&lt;script&gt;');
        (0, vitest_1.expect)(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        (0, vitest_1.expect)(rendered.html).toContain('الف &quot;ب&quot;');
        (0, vitest_1.expect)(rendered.html).not.toContain('<script>');
    });
    (0, vitest_1.it)('uses the official hosted brand mark and Vazirmatn font stack', () => {
        const rendered = (0, templates_js_1.renderEmailTemplate)({
            templateKey: 'registration',
            subject: 'موضوع',
            preheader: 'پیش‌نمایش',
            title: 'عنوان',
            paragraphs: ['متن پیام'],
        }, 'https://postyarhub.ir');
        (0, vitest_1.expect)(rendered.html).toContain('https://postyarhub.ir/email-assets/postyar-logo-mark.webp');
        (0, vitest_1.expect)(rendered.html).toContain('Vazirmatn-Regular.woff2');
        (0, vitest_1.expect)(rendered.html).toContain('font-family:Vazirmatn');
        (0, vitest_1.expect)(rendered.subject).toBe('موضوع');
    });
    (0, vitest_1.it)('applies safe editable overrides and preserves dynamic placeholders', () => {
        const rendered = (0, templates_js_1.renderEmailTemplate)({
            templateKey: 'password_reset',
            subject: 'بازیابی رمز',
            preheader: 'پیام',
            title: 'عنوان پیش‌فرض',
            paragraphs: ['مبلغ تراکنش'],
            details: [{ label: 'مبلغ', value: '۱۲۳ ریال' }],
        }, 'https://postyarhub.ir', {
            password_reset: {
                subject: 'امنیت حساب: {{subject}}',
                title: '<b>{{title}}</b>',
                paragraphs: 'جزئیات: {{detail:مبلغ}}',
            },
        });
        (0, vitest_1.expect)(rendered.subject).toBe('امنیت حساب: بازیابی رمز');
        (0, vitest_1.expect)(rendered.html).toContain('&lt;b&gt;عنوان پیش‌فرض&lt;/b&gt;');
        (0, vitest_1.expect)(rendered.html).toContain('جزئیات: ۱۲۳ ریال');
        (0, vitest_1.expect)(rendered.html).not.toContain('<b>عنوان پیش‌فرض</b>');
    });
    (0, vitest_1.it)('allows only same-origin root-relative call-to-action links', () => {
        const base = {
            subject: 'مشاهده',
            preheader: 'مشاهده',
            title: 'مشاهده در پنل',
            paragraphs: ['پیام'],
            buttonLabel: 'ورود به پنل',
        };
        (0, vitest_1.expect)(() => (0, templates_js_1.renderEmailTemplate)({ ...base, buttonPath: '//example.com/fake' }, 'https://postyarhub.ir')).toThrow();
        (0, vitest_1.expect)(() => (0, templates_js_1.renderEmailTemplate)({ ...base, buttonPath: 'https://example.com/fake' }, 'https://postyarhub.ir')).toThrow();
        (0, vitest_1.expect)(() => (0, templates_js_1.renderEmailTemplate)({ ...base, buttonPath: '/\\example.com/fake' }, 'https://postyarhub.ir')).toThrow();
        (0, vitest_1.expect)((0, templates_js_1.renderEmailTemplate)({ ...base, buttonPath: '/dashboard/help' }, 'https://postyarhub.ir').html)
            .toContain('https://postyarhub.ir/dashboard/help');
    });
});
