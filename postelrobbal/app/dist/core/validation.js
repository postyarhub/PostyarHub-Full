"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseWith = parseWith;
const errors_js_1 = require("./errors.js");
/**
 * Schema validation with Persian user-facing messages (§57-58, §43).
 * A single choke point so no English zod text can reach users.
 */
const PERSIAN_FIELD_HINTS = {
    Required: 'تکمیل این فیلد الزامی است.',
    Invalid_email: 'ایمیل معتبر نیست.',
    String_must_contain_at_least_character_s: 'متن واردشده کوتاه است.',
    String_must_contain_at_most_character_s: 'متن واردشده طولانی است.',
    Invalid_url: 'آدرس معتبر نیست.',
    Invalid_input: 'مقدار واردشده معتبر نیست.',
    Invalid_enumerated_value: 'مقدار انتخابی معتبر نیست.',
};
function persianMessage(issue) {
    const raw = issue.message.replace(/\s+/g, '_').replace(/[^A-Za-z_]/g, '_');
    if (PERSIAN_FIELD_HINTS[raw])
        return PERSIAN_FIELD_HINTS[raw];
    if (issue.code === 'invalid_type' && issue.message.includes('required'))
        return 'تکمیل این فیلد الزامی است.';
    if (issue.code === 'invalid_string' && issue.message.includes('email'))
        return 'ایمیل معتبر نیست.';
    if (issue.code === 'invalid_string' && issue.message.includes('url'))
        return 'آدرس معتبر نیست.';
    if (issue.code === 'too_small')
        return 'مقدار واردشده کوتاه است.';
    if (issue.code === 'too_big')
        return 'مقدار واردشده بزرگ‌تر از حد مجاز است.';
    if (issue.code === 'unrecognized_keys')
        return 'اطلاعات اضافی در درخواست ارسال شده است.';
    return 'اطلاعات ارسالی معتبر نیست.';
}
function parseWith(schema, input) {
    const res = schema.safeParse(input);
    if (!res.success) {
        const first = res.error.issues[0];
        const field = first?.path?.length ? ` (${String(first.path[0])})` : '';
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(first ? `${persianMessage(first)}${field}` : undefined));
    }
    return res.data;
}
