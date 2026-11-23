"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const bot_routing_js_1 = require("./bot-routing.js");
(0, vitest_1.describe)('bot reply routing isolation', () => {
    const context = { botId: 'B1', platform: 'telegram', chatRef: '-100123' };
    (0, vitest_1.it)('allows the exact originating bot/platform/chat', () => {
        (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotReplyRoute)(context, context)).not.toThrow();
    });
    (0, vitest_1.it)('blocks a different platform even when chatRef matches', () => {
        (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotReplyRoute)(context, { ...context, platform: 'bale' })).toThrow('BOT_ROUTE_MISMATCH');
    });
    (0, vitest_1.it)('blocks a different bot', () => {
        (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotReplyRoute)(context, { ...context, botId: 'B2' })).toThrow('BOT_ROUTE_MISMATCH');
    });
    (0, vitest_1.it)('blocks a different chat', () => {
        (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotReplyRoute)(context, { ...context, chatRef: '-100999' })).toThrow('BOT_ROUTE_MISMATCH');
    });
});
(0, vitest_1.describe)('three-platform cross-talk matrix', () => {
    const cases = [
        { botId: 'TG-A', platform: 'telegram', chatRef: 'TG-CHAT', platformUserId: 'USER-A' },
        { botId: 'BALE-B', platform: 'bale', chatRef: 'BALE-CHAT', platformUserId: 'USER-B' },
        { botId: 'RUBIKA-C', platform: 'rubika', chatRef: 'RUBIKA-CHAT', platformUserId: 'USER-C' },
    ];
    (0, vitest_1.it)('allows only the originating bot/platform/chat in every case', () => {
        for (const own of cases) {
            (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotReplyRoute)(own, own)).not.toThrow();
            for (const other of cases) {
                if (other.botId === own.botId)
                    continue;
                (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotReplyRoute)(own, other)).toThrow('BOT_ROUTE_MISMATCH');
            }
        }
    });
});
(0, vitest_1.describe)('bot event scope isolation', () => {
    const own = {
        tenantId: 'TENANT-A',
        botId: 'TG-A',
        platform: 'telegram',
        chatRef: 'CHAT-A',
        platformUserId: 'USER-A',
    };
    (0, vitest_1.it)('accepts the exact event envelope', () => {
        (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotEventScope)(own, own)).not.toThrow();
    });
    (0, vitest_1.it)('rejects a different tenant, bot, platform, chat, or user', () => {
        (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotEventScope)(own, { ...own, tenantId: 'TENANT-B' })).toThrow('BOT_EVENT_SCOPE_MISMATCH');
        (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotEventScope)(own, { ...own, botId: 'BALE-B' })).toThrow('BOT_EVENT_SCOPE_MISMATCH');
        (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotEventScope)(own, { ...own, platform: 'bale' })).toThrow('BOT_EVENT_SCOPE_MISMATCH');
        (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotEventScope)(own, { ...own, chatRef: 'CHAT-B' })).toThrow('BOT_EVENT_SCOPE_MISMATCH');
        (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotEventScope)(own, { ...own, platformUserId: 'USER-B' })).toThrow('BOT_EVENT_USER_SCOPE_MISMATCH');
        (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotEventScope)(own, { ...own, platformUserId: null })).toThrow('BOT_EVENT_USER_SCOPE_MISMATCH');
        (0, vitest_1.expect)(() => (0, bot_routing_js_1.assertBotEventScope)({ ...own, platformUserId: null }, own)).toThrow('BOT_EVENT_USER_SCOPE_MISMATCH');
    });
});
