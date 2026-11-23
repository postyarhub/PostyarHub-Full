"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const redisState = vitest_1.vi.hoisted(() => ({
    counts: new Map(),
    keys: [],
    shouldFail: false,
}));
vitest_1.vi.mock('../../queue/connection.js', () => ({
    getRedis: () => ({
        eval: async (_script, _keyCount, key, _windowSeconds) => {
            if (redisState.shouldFail)
                throw new Error('Redis unavailable');
            const count = (redisState.counts.get(key) ?? 0) + 1;
            redisState.counts.set(key, count);
            redisState.keys.push(key);
            return count;
        },
    }),
}));
const webhook_rate_limit_js_1 = require("./webhook-rate-limit.js");
function request(ip, botId) {
    return {
        ip,
        id: `sec01-${botId}`,
        params: { botId },
        log: { error: vitest_1.vi.fn() },
    };
}
(0, vitest_1.beforeEach)(() => {
    redisState.counts.clear();
    redisState.keys.length = 0;
    redisState.shouldFail = false;
});
(0, vitest_1.describe)('SEC-01 shared bot webhook IP limiter', () => {
    (0, vitest_1.it)('places 100 distinct bot IDs from one IP into one shared counter', async () => {
        for (let index = 0; index < 100; index += 1) {
            await (0, webhook_rate_limit_js_1.enforceBotWebhookIpLimit)(request('198.51.100.10', `invalid-${index}`));
        }
        (0, vitest_1.expect)(redisState.keys).toHaveLength(100);
        (0, vitest_1.expect)(new Set(redisState.keys).size).toBe(1);
        (0, vitest_1.expect)([...redisState.counts.values()]).toEqual([100]);
    });
    (0, vitest_1.it)('separates counter buckets for different client IPs', async () => {
        await (0, webhook_rate_limit_js_1.enforceBotWebhookIpLimit)(request('198.51.100.10', 'bot-a'));
        await (0, webhook_rate_limit_js_1.enforceBotWebhookIpLimit)(request('198.51.100.11', 'bot-b'));
        (0, vitest_1.expect)(new Set(redisState.keys).size).toBe(2);
    });
    (0, vitest_1.it)('fails closed and logs only a request identifier when Redis is unavailable', async () => {
        redisState.shouldFail = true;
        const req = request('198.51.100.10', 'bot-c');
        await (0, vitest_1.expect)((0, webhook_rate_limit_js_1.enforceBotWebhookIpLimit)(req)).rejects.toThrow();
        (0, vitest_1.expect)(req.log.error).toHaveBeenCalledWith({ requestId: req.id }, 'bot_webhook_ip_rate_limit_unavailable');
    });
});
