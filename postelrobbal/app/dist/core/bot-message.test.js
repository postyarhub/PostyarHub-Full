"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const bot_message_js_1 = require("./bot-message.js");
(0, vitest_1.describe)('bot message extraction', () => {
    (0, vitest_1.it)('extracts Telegram callback_query chat, user, and button data', () => {
        (0, vitest_1.expect)((0, bot_message_js_1.extractBotMessage)({
            update_id: 101,
            callback_query: {
                id: 'cb-1',
                data: 'PLAN_BASIC',
                from: { id: 77, username: 'user_a', first_name: 'A' },
                message: { message_id: 12, text: 'انتخاب پلن', chat: { id: -100123 } },
            },
        })).toEqual({
            text: 'انتخاب پلن', chatId: '-100123', senderId: '77', username: 'user_a', displayName: 'A', buttonId: 'PLAN_BASIC',
        });
    });
    (0, vitest_1.it)('extracts Bale/Telegram ordinary messages without changing existing semantics', () => {
        (0, vitest_1.expect)((0, bot_message_js_1.extractBotMessage)({
            update_id: 102,
            message: { text: '/start', chat: { id: 55 }, from: { id: 66, username: 'user_b' } },
        })).toEqual({ text: '/start', chatId: '55', senderId: '66', username: 'user_b', displayName: null, buttonId: null });
    });
    (0, vitest_1.it)('extracts Rubika button callbacks into the same bounded buttonId field', () => {
        (0, vitest_1.expect)((0, bot_message_js_1.extractBotMessage)({
            update: { chat_id: 'rubika-chat', new_message: { chat_id: 'rubika-chat', sender_id: 'rubika-user', text: '', aux_data: { button_id: 'PLAN_PRO' } } },
        })).toEqual({ text: '', chatId: 'rubika-chat', senderId: 'rubika-user', username: null, displayName: null, buttonId: 'PLAN_PRO' });
    });
});
