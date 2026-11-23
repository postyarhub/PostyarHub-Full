"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const rubika_js_1 = require("./rubika.js");
const { httpJsonMock } = vitest_1.vi.hoisted(() => ({ httpJsonMock: vitest_1.vi.fn() }));
vitest_1.vi.mock('../../core/http.js', async () => {
    const actual = await vitest_1.vi.importActual('../../core/http.js');
    return {
        ...actual,
        httpJson: httpJsonMock,
    };
});
(0, vitest_1.describe)('Rubika channel reference contract', () => {
    (0, vitest_1.it)('rejects obvious public username and URL forms before making a provider request', async () => {
        const adapter = new rubika_js_1.RubikaAdapter();
        await (0, vitest_1.expect)(adapter.getChat('TOKEN', '@postyarhub')).rejects.toMatchObject({ providerClass: 'VALIDATION' });
        await (0, vitest_1.expect)(adapter.getChat('TOKEN', 'https://rubika.ir/postyarhub')).rejects.toMatchObject({ providerClass: 'VALIDATION' });
        (0, vitest_1.expect)(httpJsonMock).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('lets Rubika decide whether an arbitrary non-empty chat_id is valid', async () => {
        httpJsonMock.mockReset();
        httpJsonMock.mockResolvedValue({
            status: 200,
            data: { ok: true, result: { chat: { chat_id: 'chat-xyz-123', chat_type: 'Channel', title: 'PostYar', username: 'postyarhub' } } },
        });
        const adapter = new rubika_js_1.RubikaAdapter();
        const chat = await adapter.getChat('TOKEN', ' chat-xyz-123 ');
        (0, vitest_1.expect)(chat).toEqual({ id: 'chat-xyz-123', type: 'Channel', title: 'PostYar', username: 'postyarhub' });
        const [, options] = httpJsonMock.mock.calls[0];
        (0, vitest_1.expect)(JSON.parse(options.body ?? '').chat_id).toBe('chat-xyz-123');
    });
    (0, vitest_1.it)('uses a canonical chat_id unchanged', async () => {
        httpJsonMock.mockReset();
        httpJsonMock.mockResolvedValue({
            status: 200,
            data: { ok: true, result: { chat: { chat_id: 'c0QFtn0C1I022abcd29f1d60c9ce5b08', chat_type: 'Channel', title: 'PostYar', username: 'postyarhub' } } },
        });
        const adapter = new rubika_js_1.RubikaAdapter();
        const chat = await adapter.getChat('TOKEN', ' c0QFtn0C1I022abcd29f1d60c9ce5b08 ');
        (0, vitest_1.expect)(chat.id).toBe('c0QFtn0C1I022abcd29f1d60c9ce5b08');
        const [, options] = httpJsonMock.mock.calls[0];
        (0, vitest_1.expect)(JSON.parse(options.body ?? '').chat_id).toBe('c0QFtn0C1I022abcd29f1d60c9ce5b08');
    });
});
(0, vitest_1.describe)('Rubika media button payload', () => {
    (0, vitest_1.it)('retains URL metadata and callback keypad data for file sends', () => {
        const payload = (0, rubika_js_1.decorateRubikaButtons)('caption', [
            { label: 'سایت', url: 'https://example.com' },
            { label: 'کانال', callback: 'open-channel' },
            { label: 'راهنما', callback: 'open-help' },
        ]);
        (0, vitest_1.expect)(payload.text).toContain('caption');
        (0, vitest_1.expect)(payload.text).toContain('سایت');
        (0, vitest_1.expect)(payload.metadata?.meta_data_parts[0]?.link_url).toBe('https://example.com');
        (0, vitest_1.expect)(payload.inline_keypad?.rows).toEqual([
            { buttons: [
                    { id: 'open-channel', type: 'Simple', button_text: 'کانال' },
                    { id: 'open-help', type: 'Simple', button_text: 'راهنما' },
                ] },
        ]);
    });
});
