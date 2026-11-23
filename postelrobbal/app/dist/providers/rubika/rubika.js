"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RubikaAdapter = void 0;
exports.decorateRubikaButtons = decorateRubikaButtons;
const http_js_1 = require("../../core/http.js");
const types_js_1 = require("../types.js");
const BASE = 'https://botapi.rubika.ir/v3';
function unwrap(data) {
    const result = data.result ?? data.data;
    if (result === undefined)
        throw (0, types_js_1.mapHttpToProviderError)(500, data.message ?? data.status ?? 'Rubika empty response');
    return result;
}
async function call(token, method, payload) {
    const { status, data } = await (0, http_js_1.httpJson)(`${BASE}/${token.trim()}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), timeoutMs: 20_000,
    }).catch((err) => {
        if (err && typeof err === 'object' && 'providerClass' in err && 'userMessageFa' in err)
            throw err;
        if (err instanceof http_js_1.HttpJsonParseError) {
            throw (0, types_js_1.mapHttpToProviderError)(err.status, `HTTP ${err.status} ${err.contentType || ''}`, err);
        }
        throw (0, types_js_1.makeProviderError)('TRANSIENT', 'پلتفرم روبیکا موقتاً در دسترس نیست؛ دوباره تلاش می‌شود.', err);
    });
    if (data.ok === false || data.status?.toUpperCase() === 'ERROR')
        throw (0, types_js_1.mapHttpToProviderError)(data.error_code ?? status, data.message ?? data.status ?? `HTTP ${status}`);
    return unwrap(data);
}
function utf16Metadata(text, label, url) {
    const from = text.length - label.length;
    return { type: 'Link', from_index: from, length: label.length, link_url: url };
}
function decorateRubikaButtons(text, inlineButtons) {
    let outputText = text;
    const linkMeta = [];
    const simpleButtons = [];
    for (const button of (inlineButtons ?? []).slice(0, 8)) {
        if (button.url) {
            const label = button.label || button.url;
            outputText += `\n${label}`;
            linkMeta.push(utf16Metadata(outputText, label, button.url));
        }
        else if (button.callback) {
            simpleButtons.push({
                id: button.callback.slice(0, 190),
                type: 'Simple',
                button_text: button.label.slice(0, 64),
            });
        }
    }
    const payload = { text: outputText };
    if (linkMeta.length)
        payload.metadata = { meta_data_parts: linkMeta };
    if (simpleButtons.length) {
        const rows = [];
        for (let index = 0; index < simpleButtons.length; index += 2) {
            rows.push({ buttons: simpleButtons.slice(index, index + 2) });
        }
        payload.inline_keypad = { rows };
    }
    return payload;
}
class RubikaAdapter {
    platform = 'rubika';
    capabilities() {
        return { sendText: true, sendMedia: true, editMessage: true, deleteMessage: true, inlineButtons: true, replyKeyboard: false, webhook: true, polling: false, botIdentity: true, htmlParseMode: false };
    }
    async verifyBot(token) {
        const me = await call(token, 'getMe', {});
        const bot = me.bot ?? me;
        return { id: String(bot.bot_id ?? bot.username ?? ''), username: bot.username ?? null, title: bot.bot_title ?? 'ربات روبیکا' };
    }
    async getChat(token, chatRef) {
        const normalizedRef = chatRef.trim();
        if (!normalizedRef) {
            throw (0, types_js_1.makeProviderError)('VALIDATION', 'شناسهٔ کانال روبیکا نمی‌تواند خالی باشد.');
        }
        if (/^@+/.test(normalizedRef) || /^https?:\/\/(?:www\.)?rubika\.ir\//i.test(normalizedRef)) {
            throw (0, types_js_1.makeProviderError)('VALIDATION', 'برای روبیکا باید شناسهٔ واقعی chat_id را وارد کنید؛ روش «شناسایی خودکار» در صفحهٔ کانال ساده‌تر و پیشنهادی است.');
        }
        const res = await call(token, 'getChat', { chat_id: normalizedRef });
        const chat = res.chat ?? res;
        const id = String(chat.chat_id ?? chat.id ?? '').trim();
        if (!id)
            throw (0, types_js_1.makeProviderError)('NOT_FOUND', 'مقصد روبیکا شناسهٔ معتبر ندارد.');
        const type = String(chat.chat_type ?? chat.type ?? '').trim() || null;
        return { id, type, title: chat.title ?? null, username: chat.username ?? null };
    }
    async sendText(token, input) {
        const decorated = decorateRubikaButtons(input.text, input.inlineButtons);
        const payload = { chat_id: input.chatRef, ...decorated };
        const res = await call(token, 'sendMessage', payload);
        const messageId = String(res.message_id ?? '').trim();
        if (!messageId) {
            throw (0, types_js_1.makeProviderError)('UNKNOWN', 'پاسخ روبیکا شناسهٔ پیام معتبر برنگرداند.');
        }
        return { ok: true, messageId };
    }
    async sendMedia(token, input) {
        const type = input.kind === 'photo' ? 'Image' : 'Video';
        const reservation = await call(token, 'requestSendFile', { type });
        if (!reservation.upload_url)
            throw (0, types_js_1.makeProviderError)('UNKNOWN', 'آدرس آپلود فایل از روبیکا دریافت نشد.');
        let bytes;
        let contentType;
        if (input.mediaBuffer) {
            bytes = input.mediaBuffer;
            contentType = (input.mediaMime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        }
        else {
            if (!input.mediaUrl)
                throw (0, types_js_1.makeProviderError)('VALIDATION', 'رسانهٔ قابل ارسال مشخص نشده است.');
            const source = await (0, http_js_1.httpBuffer)(input.mediaUrl, { timeoutMs: 25_000, ssrfGuard: true });
            if (source.status < 200 || source.status >= 300)
                throw (0, types_js_1.mapHttpToProviderError)(source.status, `media ${source.status}`);
            bytes = source.body;
            contentType = source.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
        }
        if (input.kind === 'photo' && contentType && !contentType.startsWith('image/')) {
            throw (0, types_js_1.makeProviderError)('VALIDATION', 'فایل تصویر مقصد، محتوای تصویری معتبر برنگرداند.');
        }
        if (input.kind === 'video' && contentType && !contentType.startsWith('video/')) {
            throw (0, types_js_1.makeProviderError)('VALIDATION', 'فایل ویدئویی مقصد، محتوای ویدئویی معتبر برنگرداند.');
        }
        const uploadType = contentType || (input.kind === 'photo' ? 'image/jpeg' : 'video/mp4');
        const uploadName = input.mediaFilename ?? (input.kind === 'photo' ? 'postyar.jpg' : 'postyar.mp4');
        const uploadResponse = await (0, http_js_1.httpMultipartJson)(reservation.upload_url, {}, { fieldName: 'file', filename: uploadName, contentType: uploadType, data: bytes }, 25_000, true);
        const uploaded = uploadResponse.data;
        if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
            throw (0, types_js_1.mapHttpToProviderError)(uploadResponse.status, String(uploaded.message ?? 'upload failed'));
        }
        const fileId = String(uploaded.file_id ?? uploaded.data?.file_id ?? uploaded.result?.file_id ?? '');
        if (!fileId)
            throw (0, types_js_1.makeProviderError)('UNKNOWN', 'فایل در روبیکا بارگذاری شد اما شناسه فایل دریافت نشد.');
        const decorated = decorateRubikaButtons(input.text || '', input.inlineButtons);
        const payload = { chat_id: input.chatRef, file_id: fileId, ...decorated };
        const res = await call(token, 'sendFile', payload);
        const messageId = String(res.message_id ?? '').trim();
        if (!messageId) {
            throw (0, types_js_1.makeProviderError)('UNKNOWN', 'پاسخ روبیکا شناسهٔ پیام معتبر برنگرداند.');
        }
        return { ok: true, messageId };
    }
    async editMessageCaption(token, chatRef, messageId, caption) {
        await call(token, 'editMessageText', { chat_id: chatRef, message_id: messageId, text: caption });
    }
    async deleteMessage(token, chatRef, messageId) {
        await call(token, 'deleteMessage', { chat_id: chatRef, message_id: messageId });
    }
    async setWebhook(token, url) {
        await call(token, 'updateBotEndpoints', { url, type: 'ReceiveUpdate' });
        await call(token, 'updateBotEndpoints', { url, type: 'ReceiveInlineMessage' });
    }
    async deleteWebhook(_token) {
        // Rubika documents endpoint updates, but not a deleteWebhook method.
        // Application-side disable therefore stops ingestion without inventing an undocumented API call.
    }
    async fetchUpdatesCursor(token, cursor) {
        const payload = { limit: 50 };
        if (cursor)
            payload.offset_id = cursor;
        const res = await call(token, 'getUpdates', payload);
        return { updates: res.updates ?? [], nextOffset: res.next_offset_id ?? null };
    }
    async fetchUpdates(token, offset) {
        const res = await this.fetchUpdatesCursor(token, offset > 0 ? String(offset) : null);
        return res.updates;
    }
}
exports.RubikaAdapter = RubikaAdapter;
