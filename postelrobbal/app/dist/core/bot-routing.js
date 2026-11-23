"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertBotReplyRoute = assertBotReplyRoute;
exports.assertBotEventScope = assertBotEventScope;
/**
 * Fail-closed routing invariant for automated bot replies.
 * A reply may only use the bot/platform/chat identity that originated the event.
 */
function assertBotReplyRoute(context, attempted) {
    if (!context.botId || !context.chatRef)
        throw new Error('BOT_ROUTE_CONTEXT_INVALID');
    if (attempted.botId !== context.botId || attempted.platform !== context.platform || attempted.chatRef !== context.chatRef) {
        throw new Error('BOT_ROUTE_MISMATCH');
    }
}
/**
 * Validate the durable event envelope against the resolved bot and provider
 * payload. Message events are rejected closed when their tenant/bot/platform,
 * chat, or user identity diverges.
 */
function assertBotEventScope(expected, actual) {
    if (!expected.tenantId || !expected.botId || !expected.chatRef)
        throw new Error('BOT_EVENT_SCOPE_INVALID');
    if (actual.tenantId !== expected.tenantId ||
        actual.botId !== expected.botId ||
        actual.platform !== expected.platform ||
        actual.chatRef !== expected.chatRef) {
        throw new Error('BOT_EVENT_SCOPE_MISMATCH');
    }
    const expectedUser = expected.platformUserId ?? null;
    const actualUser = actual.platformUserId ?? null;
    if (expectedUser !== actualUser) {
        throw new Error('BOT_EVENT_USER_SCOPE_MISMATCH');
    }
}
