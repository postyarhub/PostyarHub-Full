"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_BOT_USER_EXPORT = void 0;
exports.csvCell = csvCell;
exports.buildBotUsersCsv = buildBotUsersCsv;
exports.MAX_BOT_USER_EXPORT = 10_000;
function cellText(value) {
    if (value === null || value === undefined)
        return '';
    if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? '' : value.toISOString();
    return String(value);
}
/** Always quote CSV fields and neutralize spreadsheet formula prefixes. */
function csvCell(value) {
    let text = cellText(value);
    if (/^[\s\uFEFF]*[=+\-@]/u.test(text))
        text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}
function buildBotUsersCsv(rows) {
    const headers = ['نام نمایشی', 'شناسه پیام‌رسان', 'نام کاربری', 'اولین حضور (UTC)', 'آخرین حضور (UTC)'];
    const body = rows.map((row) => [
        row.displayName,
        row.platformUserId,
        row.username,
        row.firstSeenAt,
        row.lastSeenAt,
    ].map(csvCell).join(','));
    return `\uFEFF${headers.map(csvCell).join(',')}\r\n${body.length ? `${body.join('\r\n')}\r\n` : ''}`;
}
