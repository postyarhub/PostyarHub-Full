"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const channel_service_js_1 = require("./channel.service.js");
(0, vitest_1.describe)('channel reference normalization', () => {
    (0, vitest_1.it)('leaves Telegram/Bale public refs unchanged', () => {
        (0, vitest_1.expect)((0, channel_service_js_1.normalizeChannelRef)('telegram', '@postyarhub')).toBe('@postyarhub');
        (0, vitest_1.expect)((0, channel_service_js_1.normalizeChannelRef)('bale', '@postyarhub')).toBe('@postyarhub');
    });
    (0, vitest_1.it)('rejects obvious public usernames and URLs before provider verification', () => {
        (0, vitest_1.expect)(() => (0, channel_service_js_1.normalizeChannelRef)('rubika', '@postyarhub')).toThrow('chat_id');
        (0, vitest_1.expect)(() => (0, channel_service_js_1.normalizeChannelRef)('rubika', '@@postyarhub')).toThrow('chat_id');
        (0, vitest_1.expect)(() => (0, channel_service_js_1.normalizeChannelRef)('rubika', 'https://rubika.ir/postyarhub')).toThrow('chat_id');
    });
    (0, vitest_1.it)('accepts arbitrary non-empty Rubika provider identifiers without undocumented regex assumptions', () => {
        (0, vitest_1.expect)((0, channel_service_js_1.normalizeChannelRef)('rubika', 'chat-xyz-123')).toBe('chat-xyz-123');
        (0, vitest_1.expect)((0, channel_service_js_1.normalizeChannelRef)('rubika', ' c0QFtn0C1I022abcd29f1d60c9ce5b08 ')).toBe('c0QFtn0C1I022abcd29f1d60c9ce5b08');
    });
    (0, vitest_1.it)('extracts chat_id from a direct Rubika web link before provider verification', () => {
        (0, vitest_1.expect)((0, channel_service_js_1.normalizeChannelRef)('rubika', 'https://web.rubika.ir/#c=c0QFtn0C1I022abcd29f1d60c9ce5b08')).toBe('c0QFtn0C1I022abcd29f1d60c9ce5b08');
        (0, vitest_1.expect)((0, channel_service_js_1.normalizeChannelRef)('rubika', '#c=c0QFtn0C1I022abcd29f1d60c9ce5b08')).toBe('c0QFtn0C1I022abcd29f1d60c9ce5b08');
    });
});
(0, vitest_1.describe)('Rubika discovery command parsing', () => {
    (0, vitest_1.it)('accepts the generated one-time command format', () => {
        (0, vitest_1.expect)((0, channel_service_js_1.parseRubikaDiscoveryCommand)('/postyar-connect ABC7K9_X')).toBe('ABC7K9_X');
        (0, vitest_1.expect)((0, channel_service_js_1.parseRubikaDiscoveryCommand)('/postyar-connect@postyar_bot ABC7K9-X')).toBe('ABC7K9-X');
    });
    (0, vitest_1.it)('rejects incomplete or unrelated commands', () => {
        (0, vitest_1.expect)((0, channel_service_js_1.parseRubikaDiscoveryCommand)('/postyar-connect')).toBeNull();
        (0, vitest_1.expect)((0, channel_service_js_1.parseRubikaDiscoveryCommand)('postyar-connect ABC7K9')).toBeNull();
        (0, vitest_1.expect)((0, channel_service_js_1.parseRubikaDiscoveryCommand)('/start ABC7K9')).toBeNull();
    });
});
