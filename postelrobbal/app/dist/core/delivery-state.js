"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RETRY_POLICY = exports.POST_STATE_LABELS_FA = exports.DELIVERY_LABELS_FA = void 0;
exports.canTransition = canTransition;
exports.assertTransition = assertTransition;
exports.nextRetryDelaySeconds = nextRetryDelaySeconds;
exports.DELIVERY_LABELS_FA = {
    PENDING: 'در انتظار ارسال',
    PROCESSING: 'در حال پردازش',
    SENT: 'ارسال شد',
    RETRYING: 'در حال تلاش مجدد',
    FAILED: 'ناموفق',
    CANCELLED: 'لغو شد',
};
exports.POST_STATE_LABELS_FA = {
    DRAFT: 'پیش‌نویس',
    SCHEDULED: 'زمان‌بندی‌شده',
    QUEUED: 'در صف انتشار',
    PUBLISHING: 'در حال انتشار',
    PUBLISHED: 'منتشر شد',
    PARTIAL: 'منتشر شد (برخی مقصدها ناموفق)',
    FAILED: 'ناموفق',
    CANCELLED: 'لغو شد',
};
const ALLOWED = {
    PENDING: ['PROCESSING', 'CANCELLED'],
    PROCESSING: ['SENT', 'RETRYING', 'FAILED', 'CANCELLED'],
    RETRYING: ['PROCESSING', 'CANCELLED'],
    SENT: [],
    FAILED: ['PENDING'], // explicit user retry
    CANCELLED: [],
};
function canTransition(from, to) {
    return ALLOWED[from]?.includes(to) ?? false;
}
function assertTransition(from, to) {
    if (!canTransition(from, to)) {
        throw new Error(`Illegal delivery transition ${from} -> ${to}`);
    }
}
/** Retry classification (§86): bounded, classified, idempotent. */
exports.RETRY_POLICY = {
    maxAttempts: 5,
    backoffSeconds: [30, 120, 600, 1800],
};
function nextRetryDelaySeconds(attempts) {
    if (attempts >= exports.RETRY_POLICY.maxAttempts)
        return null;
    return exports.RETRY_POLICY.backoffSeconds[Math.min(attempts - 1, exports.RETRY_POLICY.backoffSeconds.length - 1)] ?? 1800;
}
