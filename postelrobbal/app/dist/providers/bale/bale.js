"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaleAdapter = void 0;
exports.formEncode = formEncode;
const http_js_1 = require("../../core/http.js");
const types_js_1 = require("../types.js");
/**
 * Bale adapter — tapi.bale.ai implements the Telegram Bot API protocol
 * Normal Bot API requests use the documented JSON encoding. Declared deltas:
 * deleteMessage unsupported; HTML parse mode unreliable → plain text default
 * (reference bug 9.2: "strip HTML for Bale" — we encode that as a capability).
 */
const BASE = 'https://tapi.bale.ai';
function formEncode(payload) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
        if (value === undefined || value === null)
            continue;
        form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    return form.toString();
}
async function call(token, method, payload) {
    const { status, data } = await (0, http_js_1.httpJson)(`${BASE}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: formEncode(payload),
        timeoutMs: 35_000,
    }).catch((err) => {
        if (err && typeof err === 'object' && 'providerClass' in err && 'userMessageFa' in err)
            throw err;
        if (err instanceof http_js_1.HttpJsonParseError) {
            throw (0, types_js_1.mapHttpToProviderError)(err.status, `HTTP ${err.status} ${err.contentType || ''}`, err);
        }
        throw (0, types_js_1.makeProviderError)('TRANSIENT', 'پلتفرم موقتاً در دسترس نیست؛ تلاش مجدد انجام می‌شود.', err);
    });
    if (!data.ok || data.result === undefined) {
        const description = data.description ?? `HTTP ${status}`;
        const error = (0, types_js_1.mapHttpToProviderError)(data.error_code ?? status, description, new Error(description));
        const retryAfterSeconds = data.parameters?.retry_after;
        if (Number.isFinite(retryAfterSeconds) && (retryAfterSeconds ?? 0) > 0) {
            error.retryAfterMs = Math.min(3_600_000, Math.ceil(retryAfterSeconds * 1000));
        }
        throw error;
    }
    return data.result;
}
const CHAT_ID_CACHE = new Map();
async function resolveChatId(token, chatRef) {
    const ref = chatRef.trim();
    if (!ref.startsWith('@'))
        return ref;
    const cacheKey = `${token.slice(-16)}:${ref.toLowerCase()}`;
    const cached = CHAT_ID_CACHE.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.id;
    }
    const chat = await call(token, 'getChat', { chat_id: ref });
    const id = String(chat.id ?? '').trim();
    if (!id)
        throw (0, types_js_1.makeProviderError)('NOT_FOUND', 'مقصد بله شناسهٔ معتبر ندارد.');
    CHAT_ID_CACHE.set(cacheKey, { id, expiresAt: Date.now() + 3_600_000 });
    return id;
}
class BaleAdapter {
    platform = 'bale';
    capabilities() {
        return {
            sendText: true, sendMedia: true, editMessage: true, deleteMessage: false,
            inlineButtons: true, replyKeyboard: true, webhook: true, polling: true,
            botIdentity: true, htmlParseMode: false,
        };
    }
    async verifyBot(token) {
        const me = await call(token, 'getMe', {});
        return { id: String(me.id), username: me.username ?? null, title: me.first_name };
    }
    async getChat(token, chatRef) {
        const chat = await call(token, 'getChat', { chat_id: chatRef.trim() });
        const id = String(chat.id ?? '').trim();
        if (!id)
            throw (0, types_js_1.makeProviderError)('NOT_FOUND', 'مقصد بله شناسهٔ معتبر ندارد.');
        return { id, type: chat.type ?? null, title: chat.title ?? null, username: chat.username ?? null };
    }
    buttons(input) {
        if (!input.inlineButtons?.length)
            return undefined;
        const buttons = input.inlineButtons.map((b) => {
            const label = String(b.label ?? '').trim();
            if (!label)
                throw (0, types_js_1.makeProviderError)('VALIDATION', 'عنوان دکمه نمی‌تواند خالی باشد.');
            if (b.url) {
                let protocol = '';
                try {
                    protocol = new URL(b.url.trim()).protocol;
                }
                catch {
                    throw (0, types_js_1.makeProviderError)('VALIDATION', 'لینک دکمهٔ بله معتبر نیست.');
                }
                if (!['http:', 'https:'].includes(protocol)) {
                    throw (0, types_js_1.makeProviderError)('VALIDATION', 'لینک دکمهٔ بله باید http یا https باشد.');
                }
            }
            if (b.callback && Buffer.byteLength(b.callback.trim(), 'utf8') > 64) {
                throw (0, types_js_1.makeProviderError)('VALIDATION', 'دادهٔ دکمهٔ بله بیش از حد مجاز است.');
            }
            return b.url
                ? { text: label, url: b.url.trim() }
                : { text: label, callback_data: (b.callback ?? label).trim() };
        });
        const rows = [];
        // Keep short Persian labels compact in pairs; isolate a long label only
        // when a two-column row is likely to clip it in the Bale client. This is
        // a conservative visual-width estimate, not a change to button actions.
        const visualWidth = (label) => Array.from(label).reduce((width, character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            if (/\s/u.test(character))
                return width + 0.35;
            if (codePoint >= 0x1f000 || (codePoint >= 0x2600 && codePoint <= 0x27ff))
                return width + 2;
            if (codePoint <= 0x7f) {
                if (/[ilI.,:;!|]/u.test(character))
                    return width + 0.45;
                if (/[MW@#%&]/u.test(character))
                    return width + 1.25;
                return width + 0.75;
            }
            return width + 1;
        }, 0);
        for (let index = 0; index < buttons.length;) {
            // TS strict/noUncheckedIndexedAccess treats indexed reads as possibly
            // undefined. Narrow both elements before reading their text or emitting
            // a row; this is defensive at runtime as well as type-safe.
            const current = buttons[index];
            if (!current) {
                index += 1;
                continue;
            }
            const currentWidth = visualWidth(current.text);
            const next = buttons[index + 1];
            const nextWidth = next ? visualWidth(next.text) : Number.POSITIVE_INFINITY;
            if (next && currentWidth <= 12 && nextWidth <= 12 && currentWidth + nextWidth <= 22) {
                rows.push(buttons.slice(index, index + 2));
                index += 2;
            }
            else {
                rows.push([current]);
                index += 1;
            }
        }
        return { inline_keyboard: rows };
    }
    async sendText(token, input) {
        const chatId = await resolveChatId(token, input.chatRef);
        const replyMarkup = this.buttons(input);
        const res = await call(token, 'sendMessage', {
            chat_id: chatId,
            text: input.text,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        if (!Number.isInteger(res.message_id) || res.message_id <= 0) {
            throw (0, types_js_1.makeProviderError)('UNKNOWN', 'پاسخ بله شناسهٔ پیام معتبر برنگرداند.');
        }
        return { ok: true, messageId: String(res.message_id) };
    }
    async sendMedia(token, input) {
        const method = input.kind === 'photo' ? 'sendPhoto' : 'sendVideo';
        const chatId = await resolveChatId(token, input.chatRef);
        const replyMarkup = this.buttons(input);
        if (input.mediaBuffer) {
            const fields = { chat_id: chatId };
            if (input.text)
                fields.caption = input.text;
            if (replyMarkup)
                fields.reply_markup = JSON.stringify(replyMarkup);
            const { status, data } = await (0, http_js_1.httpMultipartJson)(`${BASE}/bot${token}/${method}`, fields, {
                fieldName: input.kind === 'photo' ? 'photo' : 'video',
                filename: input.mediaFilename ?? (input.kind === 'photo' ? 'postyar.jpg' : 'postyar.mp4'),
                contentType: input.mediaMime ?? (input.kind === 'photo' ? 'image/jpeg' : 'video/mp4'),
                data: input.mediaBuffer,
            }, 45_000).catch((err) => {
                if (err && typeof err === 'object' && 'providerClass' in err && 'userMessageFa' in err)
                    throw err;
                if (err instanceof http_js_1.HttpJsonParseError) {
                    throw (0, types_js_1.mapHttpToProviderError)(err.status, `HTTP ${err.status} ${err.contentType || ''}`, err);
                }
                throw (0, types_js_1.makeProviderError)('TRANSIENT', 'پلتفرم موقتاً در دسترس نیست؛ تلاش مجدد انجام می‌شود.', err);
            });
            if (!data.ok || data.result === undefined) {
                const description = data.description ?? `HTTP ${status}`;
                const error = (0, types_js_1.mapHttpToProviderError)(data.error_code ?? status, description, new Error(description));
                const retryAfterSeconds = data.parameters?.retry_after;
                if (Number.isFinite(retryAfterSeconds) && (retryAfterSeconds ?? 0) > 0) {
                    error.retryAfterMs = Math.min(3_600_000, Math.ceil(retryAfterSeconds * 1000));
                }
                throw error;
            }
            const messageId = data.result.message_id;
            if (!Number.isInteger(messageId) || messageId <= 0)
                throw (0, types_js_1.makeProviderError)('UNKNOWN', 'پاسخ بله شناسهٔ پیام معتبر برنگرداند.');
            return { ok: true, messageId: String(messageId) };
        }
        if (!input.mediaUrl)
            throw (0, types_js_1.makeProviderError)('VALIDATION', 'رسانهٔ قابل ارسال مشخص نشده است.');
        const res = await call(token, method, {
            chat_id: chatId,
            [input.kind === 'photo' ? 'photo' : 'video']: input.mediaUrl,
            caption: input.text || undefined,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        if (!Number.isInteger(res.message_id) || res.message_id <= 0) {
            throw (0, types_js_1.makeProviderError)('UNKNOWN', 'پاسخ بله شناسهٔ پیام معتبر برنگرداند.');
        }
        return { ok: true, messageId: String(res.message_id) };
    }
    async sendMediaGroup(token, input) {
        if (input.media.length < 2 || input.media.length > 10) {
            throw (0, types_js_1.makeProviderError)('VALIDATION', 'برای ارسال آلبوم باید بین ۲ تا ۱۰ تصویر انتخاب شود.');
        }
        if (input.text.length > 1024) {
            throw (0, types_js_1.makeProviderError)('VALIDATION', 'متن همراه آلبوم حداکثر ۱۰۲۴ نویسه است.');
        }
        const chatId = await resolveChatId(token, input.chatRef);
        const replyMarkup = this.buttons(input);
        const media = input.media.map((item, index) => ({
            type: 'photo',
            media: `attach://file${index}`,
            ...(index === 0 && input.text ? { caption: input.text } : {}),
        }));
        const fields = {
            chat_id: chatId,
            media: JSON.stringify(media),
        };
        const files = input.media.map((item, index) => ({
            fieldName: `file${index}`,
            filename: item.filename,
            contentType: item.mime || 'image/jpeg',
            data: item.buffer,
        }));
        const { status, data } = await (0, http_js_1.httpMultipartJson)(`${BASE}/bot${token}/sendMediaGroup`, fields, files, 30_000).catch((err) => {
            if (err && typeof err === 'object' && 'providerClass' in err && 'userMessageFa' in err)
                throw err;
            if (err instanceof http_js_1.HttpJsonParseError) {
                throw (0, types_js_1.mapHttpToProviderError)(err.status, `HTTP ${err.status} ${err.contentType || ''}`, err);
            }
            throw (0, types_js_1.makeProviderError)('TRANSIENT', 'پلتفرم موقتاً در دسترس نیست؛ تلاش مجدد انجام می‌شود.', err);
        });
        if (!data.ok || !Array.isArray(data.result) || data.result.length !== input.media.length) {
            const description = data.description ?? `HTTP ${status}`;
            const error = (0, types_js_1.mapHttpToProviderError)(data.error_code ?? status, description, new Error(description));
            const retryAfterSeconds = data.parameters?.retry_after;
            if (Number.isFinite(retryAfterSeconds) && (retryAfterSeconds ?? 0) > 0) {
                error.retryAfterMs = Math.min(3_600_000, Math.ceil(retryAfterSeconds * 1000));
            }
            throw error;
        }
        const invalidMessage = data.result.find((item) => !Number.isInteger(item?.message_id) || (item.message_id ?? 0) <= 0);
        if (invalidMessage) {
            throw (0, types_js_1.makeProviderError)('UNKNOWN', 'پاسخ بله شامل شناسهٔ نامعتبر برای یکی از تصاویر آلبوم بود.');
        }
        const firstMessageId = data.result[0].message_id;
        if (replyMarkup) {
            try {
                await this.editMessageReplyMarkup(token, chatId, String(firstMessageId), input.inlineButtons ?? []);
            }
            catch (err) {
                // The album has already been accepted. Never classify a follow-up keyboard
                // failure as retryable, otherwise the worker could duplicate the album.
                throw (0, types_js_1.makeProviderError)('UNKNOWN', 'آلبوم ارسال شد، اما افزودن دکمه‌های آن کامل نشد؛ وضعیت کانال را بررسی کنید.', err);
            }
        }
        return { ok: true, messageId: String(firstMessageId) };
    }
    async editMessageCaption(token, chatRef, messageId, caption) {
        const chatId = await resolveChatId(token, chatRef);
        await call(token, 'editMessageCaption', { chat_id: chatId, message_id: Number(messageId), caption });
    }
    async editMessageReplyMarkup(token, chatRef, messageId, inlineButtons) {
        const chatId = await resolveChatId(token, chatRef);
        const numericMessageId = Number(messageId);
        if (!Number.isSafeInteger(numericMessageId) || numericMessageId <= 0) {
            throw (0, types_js_1.makeProviderError)('VALIDATION', 'شناسهٔ پیام برای افزودن دکمه معتبر نیست.');
        }
        const replyMarkup = this.buttons({ inlineButtons });
        if (!replyMarkup)
            return;
        await call(token, 'editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: numericMessageId,
            reply_markup: replyMarkup,
        });
    }
    async setWebhook(token, url, secret) {
        // Bale supports webhook without secret_token header; the URL path carries
        // an unguessable per-bot id and we additionally validate the update shape.
        await call(token, 'setWebhook', { url, allowed_updates: ['message', 'callback_query'] });
        void secret;
    }
    async deleteWebhook(token) {
        await call(token, 'deleteWebhook', {});
    }
    async fetchUpdates(token, offset) {
        return call(token, 'getUpdates', { offset, limit: 50, timeout: 15 });
    }
}
exports.BaleAdapter = BaleAdapter;
