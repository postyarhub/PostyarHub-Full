"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeProviderError = makeProviderError;
exports.mapHttpToProviderError = mapHttpToProviderError;
function makeProviderError(providerClass, userMessageFa, cause) {
    const err = new Error(userMessageFa);
    err.providerClass = providerClass;
    err.userMessageFa = userMessageFa;
    if (cause)
        err.cause = cause;
    return err;
}
function mapHttpToProviderError(status, description, cause) {
    const d = description.toLowerCase();
    if (status === 401 || d.includes('unauthorized'))
        return makeProviderError('UNAUTHORIZED', 'توکن ربات/کانال نامعتبر است. ربات را دوباره متصل کنید.', cause);
    if (d.includes('blocked') || d.includes('kicked') || d.includes('not enough rights') || status === 403 || d.includes('forbidden'))
        return makeProviderError('BLOCKED', 'ارسال به این مقصد مجاز نیست یا دسترسی ربات کافی نیست.', cause);
    if (status === 404 || d.includes('chat not found'))
        return makeProviderError('NOT_FOUND', 'مقصد (کانال/گفتگو) یافت نشد یا ربات عضو آن نیست.', cause);
    if (status === 429 || d.includes('too many requests'))
        return makeProviderError('RATE_LIMITED', 'محدودیت نرخ ارسال پلتفرم؛ بعداً تلاش می‌شود.', cause);
    if (status === 400 && (d.includes('parse') || d.includes('reply_markup') || d.includes('keyboard') || d.includes('button') || d.includes('url')))
        return makeProviderError('VALIDATION', 'یکی از دکمه‌ها یا لینک‌های پیام برای این پلتفرم معتبر نیست.', cause);
    if (status === 400 && (d.includes('photo') || d.includes('video') || d.includes('media') || d.includes('file')))
        return makeProviderError('VALIDATION', 'رسانهٔ پیوست‌شده برای این پلتفرم قابل انتشار نیست.', cause);
    if (status >= 500 || d.includes('timeout') || d.includes('bad gateway'))
        return makeProviderError('TRANSIENT', 'پلتفرم موقتاً در دسترس نیست؛ تلاش مجدد انجام می‌شود.', cause);
    return makeProviderError('UNKNOWN', 'ارسال به پلتفرم ناموفق بود.', cause);
}
