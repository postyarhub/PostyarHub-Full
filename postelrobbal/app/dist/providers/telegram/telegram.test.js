"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const telegram_js_1 = require("./telegram.js");
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
(0, vitest_1.describe)('Telegram media delivery payload', () => {
    (0, vitest_1.beforeEach)(() => {
        httpJsonMock.mockReset();
        httpMultipartJsonMock.mockReset();
        httpJsonMock.mockResolvedValue({ status: 200, data: { ok: true, result: { message_id: 123 } } });
        httpMultipartJsonMock.mockResolvedValue({ status: 200, data: { ok: true, result: { message_id: 456 } } });
    });
    (0, vitest_1.it)('preserves MarkdownV2 parse mode for media captions', async () => {
        const adapter = new telegram_js_1.TelegramAdapter();
        const result = await adapter.sendMedia('TOKEN', {
            chatRef: '-100123',
            text: '*hello*',
            parseMode: 'MARKDOWN',
            mediaUrl: 'https://postyar.example/media.jpg',
            kind: 'photo',
        });
        (0, vitest_1.expect)(result.messageId).toBe('123');
        const [, request] = httpJsonMock.mock.calls[0];
        const payload = JSON.parse(request.body);
        (0, vitest_1.expect)(payload.parse_mode).toBe('MarkdownV2');
    });
    (0, vitest_1.it)('builds the provider-required nested inline keyboard for media delivery', async () => {
        const adapter = new telegram_js_1.TelegramAdapter();
        const buttons = [
            { label: 'سایت', url: 'https://example.com' },
            { label: 'تلگرام', url: 'https://t.me/example' },
            { label: 'روبیکا', url: 'https://rubika.ir/example' },
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
        (0, vitest_1.expect)(markup.inline_keyboard).toEqual([[{ text: 'سایت', url: 'https://example.com' }, { text: 'تلگرام', url: 'https://t.me/example' }], [{ text: 'روبیکا', url: 'https://rubika.ir/example' }]]);
    });
    (0, vitest_1.it)('sends two photos as one official media-group request', async () => {
        httpMultipartJsonMock.mockResolvedValueOnce({
            status: 200,
            data: { ok: true, result: [{ message_id: 901 }, { message_id: 902 }] },
        });
        const adapter = new telegram_js_1.TelegramAdapter();
        const result = await adapter.sendMediaGroup('TOKEN', {
            chatRef: '-100123',
            text: 'album caption',
            parseMode: 'NONE',
            media: [
                { buffer: Buffer.from('first-photo'), filename: 'first.jpg', mime: 'image/jpeg' },
                { buffer: Buffer.from('second-photo'), filename: 'second.jpg', mime: 'image/jpeg' },
            ],
        });
        (0, vitest_1.expect)(result).toEqual({ ok: true, messageId: '901' });
        const [url, fields, files] = httpMultipartJsonMock.mock.calls[0];
        (0, vitest_1.expect)(url).toMatch(/\/sendMediaGroup$/);
        const media = JSON.parse(fields.media ?? '[]');
        (0, vitest_1.expect)(media).toEqual([
            { type: 'photo', media: 'attach://file0', caption: 'album caption' },
            { type: 'photo', media: 'attach://file1' },
        ]);
        (0, vitest_1.expect)(files.map((file) => ({ fieldName: file.fieldName, filename: file.filename }))).toEqual([
            { fieldName: 'file0', filename: 'first.jpg' },
            { fieldName: 'file1', filename: 'second.jpg' },
        ]);
    });
    (0, vitest_1.it)('rejects media groups outside the documented 2–10 photo range', async () => {
        const adapter = new telegram_js_1.TelegramAdapter();
        await (0, vitest_1.expect)(adapter.sendMediaGroup('TOKEN', {
            chatRef: '-100123',
            text: '',
            media: [{ buffer: Buffer.from('only-photo'), filename: 'only.jpg', mime: 'image/jpeg' }],
        })).rejects.toMatchObject({ providerClass: 'VALIDATION' });
        (0, vitest_1.expect)(httpMultipartJsonMock).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('uploads two photos through sendMediaGroup as one album', async () => {
        httpMultipartJsonMock.mockResolvedValueOnce({
            status: 200,
            data: { ok: true, result: [{ message_id: 101 }, { message_id: 102 }] },
        });
        const adapter = new telegram_js_1.TelegramAdapter();
        const result = await adapter.sendMediaGroup('TOKEN', {
            chatRef: '-100123',
            text: 'album caption',
            parseMode: 'HTML',
            media: [
                { buffer: Buffer.from('photo-one'), filename: 'one.jpg', mime: 'image/jpeg' },
                { buffer: Buffer.from('photo-two'), filename: 'two.jpg', mime: 'image/jpeg' },
            ],
        });
        (0, vitest_1.expect)(result).toEqual({ ok: true, messageId: '101' });
        const [url, fields, files] = httpMultipartJsonMock.mock.calls[0];
        (0, vitest_1.expect)(url).toBe('https://api.telegram.org/botTOKEN/sendMediaGroup');
        const payload = JSON.parse(fields.media ?? '');
        (0, vitest_1.expect)(payload).toEqual([
            { type: 'photo', media: 'attach://file0', caption: 'album caption', parse_mode: 'HTML' },
            { type: 'photo', media: 'attach://file1' },
        ]);
        (0, vitest_1.expect)(files).toHaveLength(2);
        (0, vitest_1.expect)(files.map((file) => [file.fieldName, file.filename])).toEqual([
            ['file0', 'one.jpg'],
            ['file1', 'two.jpg'],
        ]);
    });
    (0, vitest_1.it)('rejects an unsupported button scheme before provider send', async () => {
        const adapter = new telegram_js_1.TelegramAdapter();
        await (0, vitest_1.expect)(adapter.sendText('TOKEN', {
            chatRef: '-100123',
            text: 'hello',
            inlineButtons: [{ label: 'bad', url: 'tel:+989121234567' }],
        })).rejects.toMatchObject({ providerClass: 'VALIDATION' });
        (0, vitest_1.expect)(httpJsonMock).not.toHaveBeenCalled();
    });
});
