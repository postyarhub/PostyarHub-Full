"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const bale_js_1 = require("./bale.js");
const { httpJsonMock, httpMultipartJsonMock } = vitest_1.vi.hoisted(() => ({
    httpJsonMock: vitest_1.vi.fn(),
    httpMultipartJsonMock: vitest_1.vi.fn(),
}));
vitest_1.vi.mock('../../core/http.js', () => ({
    httpJson: httpJsonMock,
    httpMultipartJson: httpMultipartJsonMock,
    HttpJsonParseError: class HttpJsonParseError extends Error {
    },
}));
(0, vitest_1.describe)('Bale request encoding and inline keyboard payload', () => {
    (0, vitest_1.beforeEach)(() => {
        httpJsonMock.mockReset();
        httpMultipartJsonMock.mockReset();
        httpJsonMock.mockResolvedValue({ status: 200, data: { ok: true, result: { message_id: 123 } } });
        httpMultipartJsonMock.mockResolvedValue({ status: 200, data: { ok: true, result: { message_id: 456 } } });
    });
    (0, vitest_1.it)('form-encodes structured reply markup as JSON', () => {
        const encoded = (0, bale_js_1.formEncode)({
            chat_id: '-100',
            text: 'hello',
            reply_markup: { inline_keyboard: [[{ text: 'site', url: 'https://example.com' }]] },
        });
        const parsed = new URLSearchParams(encoded);
        (0, vitest_1.expect)(parsed.get('chat_id')).toBe('-100');
        (0, vitest_1.expect)(parsed.get('text')).toBe('hello');
        (0, vitest_1.expect)(JSON.parse(parsed.get('reply_markup') ?? '')).toEqual({
            inline_keyboard: [[{ text: 'site', url: 'https://example.com' }]],
        });
    });
    (0, vitest_1.it)('keeps short Bale labels paired and gives only a long label a full-width row', async () => {
        const adapter = new bale_js_1.BaleAdapter();
        const buttons = [
            { label: 'کانال تلگرام', url: 'https://t.me/example' },
            { label: 'کانال بله', url: 'https://ble.ir/example' },
            { label: 'وب‌سایت پست‌یار 🌐', url: 'https://example.com' },
            { label: 'کانال روبیکا', url: 'https://rubika.ir/example' },
            { label: 'شماره تماس', url: 'https://example.com/contact' },
        ];
        await adapter.sendMedia('TOKEN', {
            chatRef: '-100123',
            text: 'caption',
            mediaBuffer: Buffer.from('jpeg-bytes'),
            mediaFilename: 'postyar.jpg',
            mediaMime: 'image/jpeg',
            kind: 'photo',
            inlineButtons: buttons,
        });
        const [, fields] = httpMultipartJsonMock.mock.calls[0];
        const markup = JSON.parse(fields.reply_markup ?? '');
        (0, vitest_1.expect)(markup.inline_keyboard).toEqual([
            [
                { text: 'کانال تلگرام', url: 'https://t.me/example' },
                { text: 'کانال بله', url: 'https://ble.ir/example' },
            ],
            [{ text: 'وب‌سایت پست‌یار 🌐', url: 'https://example.com' }],
            [
                { text: 'کانال روبیکا', url: 'https://rubika.ir/example' },
                { text: 'شماره تماس', url: 'https://example.com/contact' },
            ],
        ]);
    });
    (0, vitest_1.it)('rejects tel URLs before provider send', async () => {
        const adapter = new bale_js_1.BaleAdapter();
        await (0, vitest_1.expect)(adapter.sendText('TOKEN', {
            chatRef: '-100123',
            text: 'hello',
            inlineButtons: [{ label: 'phone', url: 'tel:+989121234567' }],
        })).rejects.toMatchObject({ providerClass: 'VALIDATION' });
        (0, vitest_1.expect)(httpJsonMock).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('uses the documented sendMediaGroup endpoint for ordered photo albums', async () => {
        httpMultipartJsonMock.mockResolvedValue({
            status: 200,
            data: { ok: true, result: [{ message_id: 456 }, { message_id: 457 }] },
        });
        const adapter = new bale_js_1.BaleAdapter();
        const result = await adapter.sendMediaGroup('TOKEN', {
            chatRef: '-100123',
            text: 'آلبوم تصاویر',
            media: [
                { buffer: Buffer.from('photo-one'), filename: 'one.jpg', mime: 'image/jpeg' },
                { buffer: Buffer.from('photo-two'), filename: 'two.jpg', mime: 'image/jpeg' },
            ],
        });
        (0, vitest_1.expect)(result.messageId).toBe('456');
        const [url, fields, files] = httpMultipartJsonMock.mock.calls[0];
        (0, vitest_1.expect)(url).toContain('/sendMediaGroup');
        (0, vitest_1.expect)(fields.chat_id).toBe('-100123');
        const media = JSON.parse(fields.media ?? '[]');
        (0, vitest_1.expect)(media).toEqual([
            { type: 'photo', media: 'attach://file0', caption: 'آلبوم تصاویر' },
            { type: 'photo', media: 'attach://file1' },
        ]);
        (0, vitest_1.expect)(files.map((file) => [file.fieldName, file.filename])).toEqual([
            ['file0', 'one.jpg'],
            ['file1', 'two.jpg'],
        ]);
    });
    (0, vitest_1.it)('rejects album sizes outside the documented 2–10 photo range before any request', async () => {
        const adapter = new bale_js_1.BaleAdapter();
        await (0, vitest_1.expect)(adapter.sendMediaGroup('TOKEN', {
            chatRef: '-100123',
            text: '',
            media: [{ buffer: Buffer.from('one'), filename: 'one.jpg', mime: 'image/jpeg' }],
        })).rejects.toMatchObject({ providerClass: 'VALIDATION' });
        (0, vitest_1.expect)(httpMultipartJsonMock).not.toHaveBeenCalled();
        (0, vitest_1.expect)(httpJsonMock).not.toHaveBeenCalled();
    });
});
