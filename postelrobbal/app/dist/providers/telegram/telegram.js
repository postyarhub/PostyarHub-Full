"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramAdapter = void 0;
const http_js_1 = require("../../core/http.js");
const types_js_1 = require("../types.js");
/**
 * Telegram Bot API adapter — api.telegram.org.
 * Full capability set per Bot API: text, media, edit, delete, inline buttons,
 * webhook with secret_token, polling, HTML parse mode.
 */
const BASE = 'https://api.telegram.org';
async function call(token, method, payload) {
    const { status, data } = await (0, http_js_1.httpJson)(`${BASE}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
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
class TelegramAdapter {
    platform = 'telegram';
    capabilities() {
        return {
            sendText: true, sendMedia: true, editMessage: true, deleteMessage: true,
            inlineButtons: true, replyKeyboard: true, webhook: true, polling: true,
            botIdentity: true, htmlParseMode: true,
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
            throw (0, types_js_1.makeProviderError)('NOT_FOUND', 'مقصد تلگرام شناسهٔ معتبر ندارد.');
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
                    throw (0, types_js_1.makeProviderError)('VALIDATION', 'لینک دکمهٔ تلگرام معتبر نیست.');
                }
                if (!['http:', 'https:', 'tg:'].includes(protocol)) {
                    throw (0, types_js_1.makeProviderError)('VALIDATION', 'لینک دکمهٔ تلگرام باید http، https یا tg باشد.');
                }
            }
            if (b.callback && Buffer.byteLength(b.callback.trim(), 'utf8') > 64) {
                throw (0, types_js_1.makeProviderError)('VALIDATION', 'دادهٔ دکمهٔ تلگرام بیش از حد مجاز است.');
            }
            return b.url
                ? { text: label, url: b.url.trim() }
                : { text: label, callback_data: (b.callback ?? label).trim() };
        });
        const rows = [];
        for (let index = 0; index < buttons.length; index += 2) {
            rows.push(buttons.slice(index, index + 2));
        }
        return { inline_keyboard: rows };
    }
    async sendText(token, input) {
        const replyMarkup = this.buttons(input);
        const res = await call(token, 'sendMessage', {
            chat_id: input.chatRef,
            text: input.text,
            ...(input.parseMode === 'HTML' ? { parse_mode: 'HTML' } : {}),
            ...(input.parseMode === 'MARKDOWN' ? { parse_mode: 'MarkdownV2' } : {}),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            disable_web_page_preview: false,
        });
        if (!Number.isInteger(res.message_id) || res.message_id <= 0) {
            throw (0, types_js_1.makeProviderError)('UNKNOWN', 'پاسخ تلگرام شناسهٔ پیام معتبر برنگرداند.');
        }
        return { ok: true, messageId: String(res.message_id) };
    }
    async sendMedia(token, input) {
        const method = input.kind === 'photo' ? 'sendPhoto' : 'sendVideo';
        const replyMarkup = this.buttons(input);
        if (input.mediaBuffer) {
            const fields = { chat_id: input.chatRef };
            if (input.text)
                fields.caption = input.text;
            if (input.parseMode === 'HTML')
                fields.parse_mode = 'HTML';
            if (input.parseMode === 'MARKDOWN')
                fields.parse_mode = 'MarkdownV2';
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
                throw (0, types_js_1.makeProviderError)('UNKNOWN', 'پاسخ تلگرام شناسهٔ پیام معتبر برنگرداند.');
            return { ok: true, messageId: String(messageId) };
        }
        if (!input.mediaUrl)
            throw (0, types_js_1.makeProviderError)('VALIDATION', 'رسانهٔ قابل ارسال مشخص نشده است.');
        const res = await call(token, method, {
            chat_id: input.chatRef,
            [input.kind === 'photo' ? 'photo' : 'video']: input.mediaUrl,
            caption: input.text || undefined,
            ...(input.parseMode === 'HTML' ? { parse_mode: 'HTML' } : {}),
            ...(input.parseMode === 'MARKDOWN' ? { parse_mode: 'MarkdownV2' } : {}),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        if (!Number.isInteger(res.message_id) || res.message_id <= 0) {
            throw (0, types_js_1.makeProviderError)('UNKNOWN', 'پاسخ تلگرام شناسهٔ پیام معتبر برنگرداند.');
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
        const media = input.media.map((item, index) => ({
            type: 'photo',
            media: `attach://file${index}`,
            ...(index === 0 && input.text ? { caption: input.text } : {}),
            ...(index === 0 && input.parseMode === 'HTML' ? { parse_mode: 'HTML' } : {}),
            ...(index === 0 && input.parseMode === 'MARKDOWN' ? { parse_mode: 'MarkdownV2' } : {}),
        }));
        const fields = {
            chat_id: String(input.chatRef),
            media: JSON.stringify(media),
        };
        const files = input.media.map((item, index) => ({
            fieldName: `file${index}`,
            filename: item.filename,
            contentType: item.mime || 'image/jpeg',
            data: item.buffer,
        }));
        const { status, data } = await (0, http_js_1.httpMultipartJson)(`${BASE}/bot${token}/sendMediaGroup`, fields, files, 45_000).catch((err) => {
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
            throw (0, types_js_1.makeProviderError)('UNKNOWN', 'پاسخ پلتفرم شامل شناسهٔ نامعتبر برای یکی از تصاویر آلبوم بود.');
        }
        const firstMessageId = data.result[0].message_id;
        if (input.inlineButtons?.length) {
            try {
                await this.editMessageReplyMarkup(token, input.chatRef, String(firstMessageId), input.inlineButtons);
            }
            catch (err) {
                // The album is already accepted. Do not retry and duplicate it if
                // the follow-up keyboard update fails.
                throw (0, types_js_1.makeProviderError)('UNKNOWN', 'آلبوم ارسال شد، اما افزودن دکمه‌های آن کامل نشد؛ وضعیت کانال را بررسی کنید.', err);
            }
        }
        return { ok: true, messageId: String(firstMessageId) };
    }
    async editMessageReplyMarkup(token, chatRef, messageId, inlineButtons) {
        const replyMarkup = this.buttons({ inlineButtons });
        if (!replyMarkup)
            return;
        const numericMessageId = Number(messageId);
        if (!Number.isSafeInteger(numericMessageId) || numericMessageId <= 0) {
            throw (0, types_js_1.makeProviderError)('VALIDATION', 'شناسهٔ پیام برای ویرایش دکمه‌ها معتبر نیست.');
        }
        await call(token, 'editMessageReplyMarkup', {
            chat_id: chatRef,
            message_id: numericMessageId,
            reply_markup: replyMarkup,
        });
    }
    async editMessageCaption(token, chatRef, messageId, caption) {
        await call(token, 'editMessageCaption', { chat_id: chatRef, message_id: Number(messageId), caption });
    }
    async deleteMessage(token, chatRef, messageId) {
        await call(token, 'deleteMessage', { chat_id: chatRef, message_id: Number(messageId) });
    }
    async setWebhook(token, url, secret) {
        await call(token, 'setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'] });
    }
    async deleteWebhook(token) {
        await call(token, 'deleteWebhook', {});
    }
    async fetchUpdates(token, offset) {
        return call(token, 'getUpdates', { offset, limit: 50, timeout: 15 });
    }
    async getStickerSet(token, name) {
        return call(token, 'getStickerSet', { name });
    }
    async getFile(token, fileId) {
        return call(token, 'getFile', { file_id: fileId });
    }
}
exports.TelegramAdapter = TelegramAdapter;
