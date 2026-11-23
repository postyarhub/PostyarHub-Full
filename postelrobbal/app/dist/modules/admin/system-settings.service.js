"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.REFERRAL_PERCENT_MAX = exports.REFERRAL_PERCENT_MIN = exports.REFERRAL_POINTS_MAX = exports.REFERRAL_POINTS_MIN = exports.SMS_PROVIDERS = void 0;
exports.getSmsSettings = getSmsSettings;
exports.putSmsSettings = putSmsSettings;
exports.getEmailSettings = getEmailSettings;
exports.getPublicEmailSettings = getPublicEmailSettings;
exports.putEmailSettings = putEmailSettings;
exports.getEmailTemplateSettings = getEmailTemplateSettings;
exports.putEmailTemplateSettings = putEmailTemplateSettings;
exports.sendTestEmail = sendTestEmail;
exports.getGeneralSettings = getGeneralSettings;
exports.putGeneralSettings = putGeneralSettings;
exports.getAiSettings = getAiSettings;
exports.putAiSettings = putAiSettings;
exports.upsertAiProvider = upsertAiProvider;
exports.deleteAiProvider = deleteAiProvider;
exports.resolveAiRuntimeOverride = resolveAiRuntimeOverride;
exports.getReferralSettings = getReferralSettings;
exports.putReferralSettings = putReferralSettings;
exports.getGoldSettings = getGoldSettings;
exports.putGoldSettings = putGoldSettings;
exports.getSecuritySettings = getSecuritySettings;
exports.putSecuritySettings = putSecuritySettings;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const audit_js_1 = require("../../core/audit.js");
const ai_providers_js_1 = require("../../providers/ai/ai-providers.js");
const encryption_js_1 = require("../../security/encryption.js");
const nodemailer_1 = __importDefault(require("nodemailer"));
const env_js_1 = require("../../config/env.js");
const templates_js_1 = require("../../providers/email/templates.js");
/**
 * System settings for the admin panel v2 — SMS + SMTP email.
 *
 * Storage contract: one system_settings row per key, value_json holds a NATIVE
 * JSON scalar (boolean / string / number) or object (smsConfigs), mirroring how
 * payment-settings.service stores its documents. Reads merge stored values over
 * defaults; writes validate strictly and upsert per key
 * (onDuplicateKeyUpdate on setting_key).
 */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
async function upsertSetting(key, value) {
    const db = (0, client_js_1.getDb)();
    await db
        .insert(schema_js_1.systemSettings)
        .values({ settingKey: key, valueJson: value })
        .onDuplicateKeyUpdate({ set: { valueJson: value } });
}
// ---------------------------------------------------------------------------
// SMS settings
// ---------------------------------------------------------------------------
exports.SMS_PROVIDERS = ['smsir', 'melipayamak', 'kavenegar', 'ghasedak'];
/** Default credential fields per provider; otpTemplateId is capped at 20 chars. */
const SMS_CONFIG_DEFAULTS = {
    smsir: { apiKey: '', line: '', otpTemplateId: '' },
    melipayamak: { username: '', password: '', from: '' },
    kavenegar: { apiKey: '', from: '' },
    ghasedak: { apiKey: '', line: '' },
};
const SMS_FIELD_MAX = { otpTemplateId: 20 };
const SMS_DEFAULT_FIELD_MAX = 128;
function mergeSmsConfigs(stored) {
    const merged = {
        smsir: { ...SMS_CONFIG_DEFAULTS.smsir },
        melipayamak: { ...SMS_CONFIG_DEFAULTS.melipayamak },
        kavenegar: { ...SMS_CONFIG_DEFAULTS.kavenegar },
        ghasedak: { ...SMS_CONFIG_DEFAULTS.ghasedak },
    };
    if (!isRecord(stored))
        return merged;
    for (const provider of exports.SMS_PROVIDERS) {
        const raw = stored[provider];
        if (!isRecord(raw))
            continue;
        for (const field of Object.keys(SMS_CONFIG_DEFAULTS[provider])) {
            const v = raw[field];
            if (typeof v === 'string') {
                merged[provider][field] = v.slice(0, SMS_FIELD_MAX[field] ?? SMS_DEFAULT_FIELD_MAX);
            }
        }
    }
    return merged;
}
async function getSmsSettings() {
    const db = (0, client_js_1.getDb)();
    const rows = await db
        .select({ settingKey: schema_js_1.systemSettings.settingKey, valueJson: schema_js_1.systemSettings.valueJson })
        .from(schema_js_1.systemSettings)
        .where((0, drizzle_orm_1.inArray)(schema_js_1.systemSettings.settingKey, ['smsEnabled', 'smsProvider', 'smsConfigs']));
    let enabled = true;
    let provider = 'smsir';
    let storedConfigs;
    for (const row of rows) {
        if (row.settingKey === 'smsEnabled') {
            if (typeof row.valueJson === 'boolean')
                enabled = row.valueJson;
        }
        else if (row.settingKey === 'smsProvider') {
            if (typeof row.valueJson === 'string' && exports.SMS_PROVIDERS.includes(row.valueJson)) {
                provider = row.valueJson;
            }
        }
        else if (row.settingKey === 'smsConfigs') {
            storedConfigs = row.valueJson;
        }
    }
    return { enabled, provider, configs: mergeSmsConfigs(storedConfigs) };
}
/** Strict string-field validation — numbers never coerce to strings. */
function ensureSmsField(provider, field, value) {
    if (typeof value !== 'string') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`مقدار «${field}» برای «${provider}» باید متن باشد.`));
    }
    const max = SMS_FIELD_MAX[field] ?? SMS_DEFAULT_FIELD_MAX;
    if (value.trim().length > max) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`مقدار «${field}» بیش از حد مجاز است.`));
    }
    return value.trim();
}
async function putSmsSettings(patch) {
    const updated = [];
    if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مقدار «enabled» باید بولی باشد.'));
        }
        await upsertSetting('smsEnabled', patch.enabled);
        updated.push('smsEnabled');
    }
    if (patch.provider !== undefined) {
        if (!exports.SMS_PROVIDERS.includes(patch.provider)) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('سرویس‌دهنده پیامک معتبر نیست.'));
        }
        await upsertSetting('smsProvider', patch.provider);
        updated.push('smsProvider');
    }
    if (patch.configs !== undefined) {
        const db = (0, client_js_1.getDb)();
        const [row] = await db
            .select({ valueJson: schema_js_1.systemSettings.valueJson })
            .from(schema_js_1.systemSettings)
            .where((0, drizzle_orm_1.eq)(schema_js_1.systemSettings.settingKey, 'smsConfigs'))
            .limit(1);
        const merged = mergeSmsConfigs(row?.valueJson);
        for (const provider of exports.SMS_PROVIDERS) {
            const providerPatch = patch.configs[provider];
            if (!providerPatch)
                continue;
            for (const [field, value] of Object.entries(providerPatch)) {
                if (value === undefined)
                    continue;
                if (!(field in SMS_CONFIG_DEFAULTS[provider])) {
                    throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`فیلد «${field}» برای «${provider}» معتبر نیست.`));
                }
                merged[provider][field] = ensureSmsField(provider, field, value);
            }
        }
        await upsertSetting('smsConfigs', merged);
        updated.push('smsConfigs');
    }
    return updated;
}
const EMAIL_DEFAULTS = {
    enabled: true,
    host: '',
    port: 587,
    secure: false,
    user: '',
    pass: '',
    fromName: 'پُست‌یار',
    fromEmail: '',
};
const EMAIL_KEYS = [
    'emailEnabled',
    'smtpHost',
    'smtpPort',
    'smtpSecure',
    'smtpUser',
    'smtpPass',
    'fromName',
    'fromEmail',
];
async function getEmailSettings() {
    const db = (0, client_js_1.getDb)();
    const rows = await db
        .select({ settingKey: schema_js_1.systemSettings.settingKey, valueJson: schema_js_1.systemSettings.valueJson })
        .from(schema_js_1.systemSettings)
        .where((0, drizzle_orm_1.inArray)(schema_js_1.systemSettings.settingKey, [...EMAIL_KEYS]));
    const settings = { ...EMAIL_DEFAULTS };
    for (const row of rows) {
        const v = row.valueJson; // JSON column: native scalar at runtime
        switch (row.settingKey) {
            case 'emailEnabled':
                if (typeof v === 'boolean')
                    settings.enabled = v;
                break;
            case 'smtpHost':
                if (typeof v === 'string')
                    settings.host = v;
                break;
            case 'smtpPort':
                if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535)
                    settings.port = v;
                break;
            case 'smtpSecure':
                if (typeof v === 'boolean')
                    settings.secure = v;
                break;
            case 'smtpUser':
                if (typeof v === 'string')
                    settings.user = v;
                break;
            case 'smtpPass':
                if (typeof v === 'string') {
                    if (v.startsWith('v1.')) {
                        try {
                            settings.pass = (0, encryption_js_1.decryptSecret)(v);
                        }
                        catch {
                            settings.pass = '';
                        }
                    }
                    else {
                        // Legacy value remains readable; every newly saved secret is encrypted.
                        settings.pass = v;
                    }
                }
                break;
            case 'fromName':
                if (typeof v === 'string' && v.trim() !== '')
                    settings.fromName = v;
                break;
            case 'fromEmail':
                if (typeof v === 'string')
                    settings.fromEmail = v;
                break;
        }
    }
    return settings;
}
async function getPublicEmailSettings() {
    const settings = await getEmailSettings();
    return { ...settings, pass: '', passwordConfigured: Boolean(settings.pass) };
}
function ensureEmailStr(value, field, max) {
    if (typeof value !== 'string') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`مقدار «${field}» باید متن باشد.`));
    }
    if (value.trim().length > max) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`مقدار «${field}» بیش از حد مجاز است.`));
    }
    return value.trim();
}
async function putEmailSettings(patch) {
    const updated = [];
    if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مقدار «enabled» باید بولی باشد.'));
        }
        await upsertSetting('emailEnabled', patch.enabled);
        updated.push('emailEnabled');
    }
    if (patch.host !== undefined) {
        await upsertSetting('smtpHost', ensureEmailStr(patch.host, 'host', 190));
        updated.push('smtpHost');
    }
    if (patch.port !== undefined) {
        if (typeof patch.port !== 'number' || !Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مقدار «port» باید عددی بین ۱ تا ۶۵۵۳۵ باشد.'));
        }
        await upsertSetting('smtpPort', patch.port);
        updated.push('smtpPort');
    }
    if (patch.secure !== undefined) {
        if (typeof patch.secure !== 'boolean') {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مقدار «secure» باید بولی باشد.'));
        }
        await upsertSetting('smtpSecure', patch.secure);
        updated.push('smtpSecure');
    }
    if (patch.user !== undefined) {
        await upsertSetting('smtpUser', ensureEmailStr(patch.user, 'user', 190));
        updated.push('smtpUser');
    }
    if (patch.pass !== undefined) {
        const password = ensureEmailStr(patch.pass, 'pass', 190);
        // Blank input means "preserve saved password"; non-empty secrets are encrypted.
        if (password) {
            await upsertSetting('smtpPass', (0, encryption_js_1.encryptSecret)(password));
            updated.push('smtpPass');
        }
    }
    if (patch.fromName !== undefined) {
        await upsertSetting('fromName', ensureEmailStr(patch.fromName, 'fromName', 80));
        updated.push('fromName');
    }
    if (patch.fromEmail !== undefined) {
        const email = ensureEmailStr(patch.fromEmail, 'fromEmail', 190);
        if (email !== '' && !email.includes('@')) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ایمیل فرستنده معتبر نیست.'));
        }
        await upsertSetting('fromEmail', email);
        updated.push('fromEmail');
    }
    return updated;
}
/* ---------------------------------------------------------------------------
 * Editable transactional-email content. Stored under one system_settings key;
 * no schema migration is required. HTML is never accepted from the admin UI.
 * ------------------------------------------------------------------------- */
const EMAIL_TEMPLATE_FIELDS = ['subject', 'preheader', 'title', 'greeting', 'paragraphs', 'buttonLabel', 'footerNote'];
const EMAIL_TEMPLATE_LIMITS = {
    subject: 190,
    preheader: 180,
    title: 160,
    greeting: 180,
    paragraphs: 4000,
    buttonLabel: 100,
    footerNote: 300,
};
async function getEmailTemplateSettings() {
    const stored = await readSettingDoc('emailTemplates');
    const result = {};
    for (const key of templates_js_1.EMAIL_TEMPLATE_KEYS) {
        const source = stored[key];
        if (!isRecord(source))
            continue;
        const output = {};
        for (const field of EMAIL_TEMPLATE_FIELDS) {
            const value = source[field];
            if (typeof value === 'string' && value.length <= EMAIL_TEMPLATE_LIMITS[field]) {
                output[field] = value;
            }
        }
        if (Object.keys(output).length > 0)
            result[key] = output;
    }
    return result;
}
async function putEmailTemplateSettings(key, patch) {
    if (!templates_js_1.EMAIL_TEMPLATE_KEYS.includes(key)) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('قالب ایمیل انتخاب‌شده معتبر نیست.'));
    }
    const current = await getEmailTemplateSettings();
    const next = { ...current, [key]: { ...(current[key] ?? {}) } };
    const output = next[key];
    const updated = [];
    for (const field of EMAIL_TEMPLATE_FIELDS) {
        const value = patch[field];
        if (value === undefined)
            continue;
        if (typeof value !== 'string' || value.length > EMAIL_TEMPLATE_LIMITS[field]) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('یکی از فیلدهای قالب ایمیل بیش از حد مجاز است.'));
        }
        output[field] = field === 'paragraphs' ? value.trim() : value.trim().replace(/[\r\n]+/g, ' ');
        updated.push(field);
    }
    await upsertSetting('emailTemplates', next);
    return updated;
}
/**
 * Sends a test email through the SAVED SMTP settings (nodemailer).

 * Never leaks credentials in errors — only the SMTP response line is surfaced.
 */
async function sendTestEmail(actorId, to) {
    const settings = await getEmailSettings();
    if (!settings.enabled || !settings.host || !settings.user || !settings.pass) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ایمیل را فعال کنید و تنظیمات SMTP، نام کاربری و رمز عبور را کامل و ذخیره کنید.'));
    }
    const secure = settings.port === 465 ? true : settings.port === 587 ? false : settings.secure;
    const transport = nodemailer_1.default.createTransport({
        host: settings.host,
        port: settings.port,
        secure,
        requireTLS: !secure,
        auth: { user: settings.user, pass: settings.pass },
        tls: { minVersion: 'TLSv1.2' },
        connectionTimeout: 20_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
    });
    try {
        const rendered = (0, templates_js_1.renderEmailTemplate)({
            templateKey: 'test_email',
            subject: 'ایمیل آزمایشی پُست‌یار',
            preheader: 'بررسی نهایی اتصال ایمیل پُست‌یار.',
            title: 'ارسال ایمیل آماده است',
            greeting: 'سلام،',
            paragraphs: ['تنظیمات SMTP با موفقیت آزموده شد. اگر این پیام را دریافت کرده‌اید، ارسال ایمیل پُست‌یار کار می‌کند.'],
            buttonLabel: 'ورود به پنل پُست‌یار',
            buttonPath: '/login',
            footerNote: 'این پیام فقط برای بررسی تنظیمات ارسال شده است.',
        }, (0, env_js_1.loadEnv)().APP_URL, await getEmailTemplateSettings());
        const info = await transport.sendMail({
            from: { name: settings.fromName, address: settings.fromEmail || settings.user },
            to,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
        });
        await (0, audit_js_1.audit)({ action: 'admin.email_test', actorId, meta: { to } });
        return { ok: true, messageId: String(info.messageId ?? '') };
    }
    catch {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ارسال ایمیل آزمایشی ناموفق بود. میزبان، پورت، نوع اتصال امن و اعتبارنامه‌های SMTP را بررسی کنید.'));
    }
    finally {
        transport.close();
    }
}
// ---------------------------------------------------------------------------
// Round 17 — dedicated form-shaped settings: general / ai / referral / security
//
// One system_settings key per namespace; value_json holds the whole document.
// Reads merge stored values over defaults (type-checked per field, so a
// hand-edited row can never crash the API); writes validate strictly with
// Persian messages and upsert per key. The 'ai' document field name is
// load-bearing: ai.service.resolveProvider() reads valueJson['default_provider'].
// ---------------------------------------------------------------------------
async function readSettingDoc(key) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({ valueJson: schema_js_1.systemSettings.valueJson })
        .from(schema_js_1.systemSettings)
        .where((0, drizzle_orm_1.eq)(schema_js_1.systemSettings.settingKey, key))
        .limit(1);
    return isRecord(row?.valueJson) ? row.valueJson : {};
}
/** Strict string-field validation — numbers never coerce to strings. */
function ensureDocStr(value, field, max) {
    if (typeof value !== 'string') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`مقدار «${field}» باید متن باشد.`));
    }
    const v = value.trim();
    if (v.length > max) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`مقدار «${field}» باید حداکثر ${max} کاراکتر باشد.`));
    }
    return v;
}
function ensureDocBool(value, field) {
    if (typeof value !== 'boolean') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`مقدار «${field}» باید بولی باشد.`));
    }
    return value;
}
const GENERAL_LIMITS = {
    siteNameFa: 60,
    siteTaglineFa: 120,
    supportEmail: 190,
    supportPhone: 20,
    supportTelegramUrl: 190,
    supportBaleUrl: 190,
    termsNoteFa: 300,
    maintenanceMessageFa: 300,
};
const GENERAL_DEFAULTS = {
    siteNameFa: 'پُست‌یار',
    siteTaglineFa: '',
    supportEmail: '',
    supportPhone: '',
    supportTelegramUrl: '',
    supportBaleUrl: '',
    termsNoteFa: '',
    maintenanceEnabled: false,
    maintenanceMessageFa: '',
};
async function getGeneralSettings() {
    const doc = await readSettingDoc('general');
    const s = { ...GENERAL_DEFAULTS };
    const str = (k) => {
        const v = doc[k];
        return typeof v === 'string' ? v.trim().slice(0, GENERAL_LIMITS[k]) : undefined;
    };
    const siteName = str('siteNameFa');
    if (siteName)
        s.siteNameFa = siteName; // default is non-empty — never blank
    s.siteTaglineFa = str('siteTaglineFa') ?? s.siteTaglineFa;
    s.supportEmail = str('supportEmail') ?? s.supportEmail;
    s.supportPhone = str('supportPhone') ?? s.supportPhone;
    s.supportTelegramUrl = str('supportTelegramUrl') ?? s.supportTelegramUrl;
    s.supportBaleUrl = str('supportBaleUrl') ?? s.supportBaleUrl;
    s.termsNoteFa = str('termsNoteFa') ?? s.termsNoteFa;
    if (typeof doc['maintenanceEnabled'] === 'boolean')
        s.maintenanceEnabled = doc['maintenanceEnabled'];
    s.maintenanceMessageFa = str('maintenanceMessageFa') ?? s.maintenanceMessageFa;
    return s;
}
async function putGeneralSettings(patch) {
    const merged = await getGeneralSettings();
    const updated = [];
    if (patch.siteNameFa !== undefined) {
        const v = ensureDocStr(patch.siteNameFa, 'siteNameFa', GENERAL_LIMITS.siteNameFa);
        if (v === '')
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('نام سایت الزامی است.'));
        merged.siteNameFa = v;
        updated.push('siteNameFa');
    }
    if (patch.siteTaglineFa !== undefined) {
        merged.siteTaglineFa = ensureDocStr(patch.siteTaglineFa, 'siteTaglineFa', GENERAL_LIMITS.siteTaglineFa);
        updated.push('siteTaglineFa');
    }
    if (patch.supportEmail !== undefined) {
        const v = ensureDocStr(patch.supportEmail, 'supportEmail', GENERAL_LIMITS.supportEmail);
        if (v !== '' && !v.includes('@'))
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ایمیل پشتیبانی معتبر نیست.'));
        merged.supportEmail = v;
        updated.push('supportEmail');
    }
    if (patch.supportPhone !== undefined) {
        merged.supportPhone = ensureDocStr(patch.supportPhone, 'supportPhone', GENERAL_LIMITS.supportPhone);
        updated.push('supportPhone');
    }
    if (patch.supportTelegramUrl !== undefined) {
        const v = ensureDocStr(patch.supportTelegramUrl, 'supportTelegramUrl', GENERAL_LIMITS.supportTelegramUrl);
        if (v !== '' && !v.startsWith('https://')) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('آدرس تلگرام باید با https:// شروع شود.'));
        }
        merged.supportTelegramUrl = v;
        updated.push('supportTelegramUrl');
    }
    if (patch.supportBaleUrl !== undefined) {
        const v = ensureDocStr(patch.supportBaleUrl, 'supportBaleUrl', GENERAL_LIMITS.supportBaleUrl);
        if (v !== '' && !v.startsWith('https://')) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('آدرس بله باید با https:// شروع شود.'));
        }
        merged.supportBaleUrl = v;
        updated.push('supportBaleUrl');
    }
    if (patch.termsNoteFa !== undefined) {
        merged.termsNoteFa = ensureDocStr(patch.termsNoteFa, 'termsNoteFa', GENERAL_LIMITS.termsNoteFa);
        updated.push('termsNoteFa');
    }
    if (patch.maintenanceEnabled !== undefined) {
        merged.maintenanceEnabled = ensureDocBool(patch.maintenanceEnabled, 'maintenanceEnabled');
        updated.push('maintenanceEnabled');
    }
    if (patch.maintenanceMessageFa !== undefined) {
        merged.maintenanceMessageFa = ensureDocStr(patch.maintenanceMessageFa, 'maintenanceMessageFa', GENERAL_LIMITS.maintenanceMessageFa);
        updated.push('maintenanceMessageFa');
    }
    await upsertSetting('general', merged);
    return updated;
}
const AI_SAFE_ID = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const AI_SAFE_MODEL = /^[^\s]{1,120}$/;
function builtinProviders() {
    return ai_providers_js_1.BUILTIN_AI_PROVIDERS.map(p => ({ id: p.id, title: p.title, kind: p.kind, baseUrl: p.baseUrl, models: [...p.models], selectedModel: p.models[0] ?? '', builtIn: true }));
}
function normalizeUrl(url) {
    if (url === 'internal://postyar' || url === 'internal://local')
        return url;
    let u;
    try {
        u = new URL(url);
    }
    catch {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('آدرس سرویس‌دهنده معتبر نیست.'));
    }
    if (u.protocol !== 'https:')
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('آدرس سرویس‌دهنده باید HTTPS باشد.'));
    if (u.username || u.password)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('آدرس سرویس‌دهنده نباید نام کاربری یا رمز عبور داشته باشد.'));
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const privateV4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/;
    const privateV6 = host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb');
    if (host === 'localhost' || host.endsWith('.local') || privateV4.test(host) || privateV6)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('آدرس سرویس‌دهندهٔ داخلی مجاز نیست.'));
    return u.toString().replace(/\/$/, '');
}
function sanitizeProvider(raw) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.kind !== 'string' || typeof raw.baseUrl !== 'string' || !Array.isArray(raw.models))
        return null;
    if (!AI_SAFE_ID.test(raw.id) || typeof raw.selectedModel !== 'string' || !['openai-compatible', 'gemini', 'anthropic', 'local'].includes(raw.kind))
        return null;
    const models = raw.models.filter((v) => typeof v === 'string' && AI_SAFE_MODEL.test(v)).slice(0, 100);
    if (!models.length)
        return null;
    try {
        const baseUrl = normalizeUrl(raw.baseUrl);
        const selected = models.includes(raw.selectedModel) ? raw.selectedModel : (models[0] ?? '');
        const out = { id: raw.id, title: raw.title.trim().slice(0, 100), kind: raw.kind, baseUrl, models, selectedModel: selected, builtIn: raw.builtIn === true };
        if (typeof raw.apiKeyEncrypted === 'string' && raw.apiKeyEncrypted.trim())
            out.apiKeyEncrypted = raw.apiKeyEncrypted;
        return out;
    }
    catch {
        return null;
    }
}
function readProviders(doc) {
    const raw = doc['providers'];
    const out = [];
    if (Array.isArray(raw))
        for (const item of raw) {
            const p = sanitizeProvider(item);
            if (p)
                out.push(p);
        }
    for (const b of builtinProviders()) {
        const existing = out.find(p => p.id === b.id);
        if (!existing) {
            out.push(b);
        }
        else {
            existing.title = b.title;
            const combined = [...new Set([...existing.models, ...b.models])];
            existing.models = combined;
            if (!existing.selectedModel)
                existing.selectedModel = b.selectedModel;
        }
    }
    return out;
}
async function getAiSettings() {
    const doc = await readSettingDoc('ai');
    const providers = readProviders(doc);
    const defaultProvider = typeof doc.default_provider === 'string' && providers.some(p => p.id === doc.default_provider) ? doc.default_provider : 'local';
    return { defaultProvider, providers: providers.map(p => ({ ...p, hasApiKey: p.id === 'local' ? true : Boolean(p.apiKeyEncrypted), apiKeyMasked: p.id === 'local' ? 'موتور بومی (فعال)' : (p.apiKeyEncrypted ? 'کلید ذخیره‌شده' : 'کلید محیط سرور'), apiKeyEncrypted: undefined })) };
}
async function putAiSettings(patch) {
    if (patch.default_provider !== undefined) {
        const settings = await getAiSettings();
        if (!settings.providers.some(p => p.id === patch.default_provider))
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('سرویس‌دهندهٔ هوش مصنوعی معتبر نیست.'));
        const doc = await readSettingDoc('ai');
        doc.default_provider = patch.default_provider;
        await upsertSetting('ai', doc);
        return ['default_provider'];
    }
    return [];
}
async function upsertAiProvider(input) {
    const id = input.id?.trim().toLowerCase() || `custom-${Date.now().toString(36)}`;
    if (!AI_SAFE_ID.test(id))
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('شناسهٔ سرویس‌دهنده معتبر نیست.'));
    const baseUrl = normalizeUrl(input.baseUrl);
    const models = [...new Set(input.models.map(x => x.trim()).filter(x => AI_SAFE_MODEL.test(x)))].slice(0, 100);
    if (!models.length)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('حداقل یک نام مدل معتبر وارد کنید.'));
    if (!models.includes(input.selectedModel))
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مدل انتخاب‌شده باید در فهرست مدل‌ها باشد.'));
    const doc = await readSettingDoc('ai');
    const providers = readProviders(doc);
    const existing = providers.find(p => p.id === id);
    const builtin = ai_providers_js_1.BUILTIN_AI_PROVIDERS.find(p => p.id === id);
    if (builtin) {
        const combinedModels = [...new Set([...builtin.models, ...models])];
        const selected = combinedModels.includes(input.selectedModel) ? input.selectedModel : (combinedModels[0] ?? '');
        const next = { id, title: builtin.title, kind: builtin.kind, baseUrl: input.baseUrl ? normalizeUrl(input.baseUrl) : builtin.baseUrl, models: combinedModels, selectedModel: selected, builtIn: true };
        if (input.apiKey !== undefined) {
            if (input.apiKey.length > 190)
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('کلید سرویس‌دهنده بیش از حد مجاز است.'));
            if (input.apiKey.trim())
                next.apiKeyEncrypted = (0, encryption_js_1.encryptSecret)(input.apiKey.trim());
        }
        else if (existing?.apiKeyEncrypted)
            next.apiKeyEncrypted = existing.apiKeyEncrypted;
        const index = providers.findIndex(p => p.id === id);
        if (index >= 0)
            providers[index] = next;
        else
            providers.push(next);
        doc.providers = providers;
        await upsertSetting('ai', doc);
        return getAiSettings();
    }
    const next = { id, title: input.title.trim().slice(0, 100), kind: input.kind, baseUrl, models, selectedModel: input.selectedModel.trim(), builtIn: false };
    if (input.apiKey !== undefined) {
        if (input.apiKey.length > 190)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('کلید سرویس‌دهنده بیش از حد مجاز است.'));
        if (input.apiKey.trim())
            next.apiKeyEncrypted = (0, encryption_js_1.encryptSecret)(input.apiKey.trim());
    }
    else if (existing?.apiKeyEncrypted)
        next.apiKeyEncrypted = existing.apiKeyEncrypted;
    const index = providers.findIndex(p => p.id === id);
    if (index >= 0)
        providers[index] = next;
    else
        providers.push(next);
    doc.providers = providers;
    await upsertSetting('ai', doc);
    return getAiSettings();
}
async function deleteAiProvider(id) {
    const doc = await readSettingDoc('ai');
    const providers = readProviders(doc);
    const target = providers.find(p => p.id === id);
    if (!target)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('سرویس‌دهندهٔ هوش مصنوعی'));
    if (target.builtIn)
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('سرویس‌دهندهٔ پایه حذف نمی‌شود.'));
    const next = providers.filter(p => p.id !== id);
    doc.providers = next;
    if (doc.default_provider === id)
        doc.default_provider = next[0]?.id ?? 'openai';
    await upsertSetting('ai', doc);
    return getAiSettings();
}
async function resolveAiRuntimeOverride(provider) {
    const p = (provider || '').toLowerCase();
    if (p === 'local' || p === 'internal') {
        return { kind: 'local', model: 'postyar-smart-fa' };
    }
    const doc = await readSettingDoc('ai');
    const found = readProviders(doc).find(x => x.id === p);
    if (!found)
        return {};
    const out = { baseUrl: found.baseUrl, model: found.selectedModel, kind: found.kind };
    if (found.apiKeyEncrypted && found.id !== 'local') {
        try {
            out.key = (0, encryption_js_1.decryptSecret)(found.apiKeyEncrypted);
        }
        catch {
            throw new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
        }
    }
    return out;
}
exports.REFERRAL_POINTS_MIN = 0;
exports.REFERRAL_POINTS_MAX = 100000;
exports.REFERRAL_PERCENT_MIN = 0;
exports.REFERRAL_PERCENT_MAX = 50;
const REFERRAL_DEFAULTS = { registerRewardPoints: 100, enabled: true, firstPurchasePercent: 10 };
async function getReferralSettings() {
    const doc = await readSettingDoc('referral');
    const s = { ...REFERRAL_DEFAULTS };
    const rawPoints = doc['registerRewardPoints'];
    if (typeof rawPoints === 'number' &&
        Number.isInteger(rawPoints) &&
        rawPoints >= exports.REFERRAL_POINTS_MIN &&
        rawPoints <= exports.REFERRAL_POINTS_MAX) {
        s.registerRewardPoints = rawPoints;
    }
    if (typeof doc['enabled'] === 'boolean')
        s.enabled = doc['enabled'];
    const rawPercent = doc['firstPurchasePercent'];
    if (typeof rawPercent === 'number' &&
        Number.isInteger(rawPercent) &&
        rawPercent >= exports.REFERRAL_PERCENT_MIN &&
        rawPercent <= exports.REFERRAL_PERCENT_MAX) {
        s.firstPurchasePercent = rawPercent;
    }
    return s;
}
async function putReferralSettings(patch) {
    const merged = { ...(await readSettingDoc('referral')) };
    const updated = [];
    if (patch.registerRewardPoints !== undefined) {
        const v = patch.registerRewardPoints;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < exports.REFERRAL_POINTS_MIN || v > exports.REFERRAL_POINTS_MAX) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('امتیاز پاداش معرفی باید عدد صحیح بین ۰ تا ۱۰۰۰۰۰ باشد.'));
        }
        merged['registerRewardPoints'] = v;
        updated.push('registerRewardPoints');
    }
    if (patch.enabled !== undefined) {
        merged['enabled'] = ensureDocBool(patch.enabled, 'enabled');
        updated.push('enabled');
    }
    if (patch.firstPurchasePercent !== undefined) {
        const v = patch.firstPurchasePercent;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < exports.REFERRAL_PERCENT_MIN || v > exports.REFERRAL_PERCENT_MAX) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('درصد پاداش خرید اول باید عددی بین ۰ تا ۵۰ باشد.'));
        }
        merged['firstPurchasePercent'] = v;
        updated.push('firstPurchasePercent');
    }
    await upsertSetting('referral', merged);
    return updated;
}
const GOLD_DEFAULTS = { defaultSourceUrl: '', defaultFrequencyMinutes: 60, defaultTemplateFa: '', apiToken: '' };
const GOLD_LIMITS = { defaultSourceUrl: 512, defaultTemplateFa: 2000, apiToken: 1024 };
const GOLD_FREQUENCY_MIN = 15;
const GOLD_FREQUENCY_MAX = 1440;
async function getGoldSettings() {
    const doc = await readSettingDoc('gold');
    const s = { ...GOLD_DEFAULTS };
    const rawUrl = doc['defaultSourceUrl'];
    if (typeof rawUrl === 'string')
        s.defaultSourceUrl = rawUrl.trim().slice(0, GOLD_LIMITS.defaultSourceUrl);
    const rawFreq = doc['defaultFrequencyMinutes'];
    if (typeof rawFreq === 'number' &&
        Number.isInteger(rawFreq) &&
        rawFreq >= GOLD_FREQUENCY_MIN &&
        rawFreq <= GOLD_FREQUENCY_MAX) {
        s.defaultFrequencyMinutes = rawFreq;
    }
    const rawTemplate = doc['defaultTemplateFa'];
    if (typeof rawTemplate === 'string')
        s.defaultTemplateFa = rawTemplate.slice(0, GOLD_LIMITS.defaultTemplateFa);
    const rawToken = doc['apiToken'];
    if (typeof rawToken === 'string')
        s.apiToken = rawToken.trim().slice(0, GOLD_LIMITS.apiToken);
    return s;
}
async function putGoldSettings(patch) {
    const merged = { ...(await readSettingDoc('gold')) };
    const updated = [];
    if (patch.defaultSourceUrl !== undefined) {
        const v = ensureDocStr(patch.defaultSourceUrl, 'defaultSourceUrl', GOLD_LIMITS.defaultSourceUrl);
        // Scheme-only validation here: the FULL SSRF check (assertSafeUrl) still
        // happens on the user-side save paths in gold.service.saveGoldConfig.
        if (v !== '' && !v.startsWith('https://')) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('آدرس منبع پیش‌فرض باید با https:// شروع شود.'));
        }
        merged['defaultSourceUrl'] = v;
        updated.push('defaultSourceUrl');
    }
    if (patch.defaultFrequencyMinutes !== undefined) {
        const v = patch.defaultFrequencyMinutes;
        if (typeof v !== 'number' ||
            !Number.isInteger(v) ||
            v < GOLD_FREQUENCY_MIN ||
            v > GOLD_FREQUENCY_MAX) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('فاصلهٔ به‌روزرسانی پیش‌فرض باید بین ۱۵ تا ۱۴۴۰ دقیقه باشد.'));
        }
        merged['defaultFrequencyMinutes'] = v;
        updated.push('defaultFrequencyMinutes');
    }
    if (patch.defaultTemplateFa !== undefined) {
        merged['defaultTemplateFa'] = ensureDocStr(patch.defaultTemplateFa, 'defaultTemplateFa', GOLD_LIMITS.defaultTemplateFa);
        updated.push('defaultTemplateFa');
    }
    if (patch.apiToken !== undefined) {
        merged['apiToken'] = typeof patch.apiToken === 'string' ? patch.apiToken.trim().slice(0, GOLD_LIMITS.apiToken) : '';
        updated.push('apiToken');
    }
    await upsertSetting('gold', merged);
    return updated;
}
const SECURITY_DEFAULTS = { registrationEnabled: true, captchaEnabled: true };
async function getSecuritySettings() {
    try {
        const doc = await readSettingDoc('security');
        const s = { ...SECURITY_DEFAULTS };
        if (typeof doc['registrationEnabled'] === 'boolean')
            s.registrationEnabled = doc['registrationEnabled'];
        if (typeof doc['captchaEnabled'] === 'boolean')
            s.captchaEnabled = doc['captchaEnabled'];
        return s;
    }
    catch {
        return { ...SECURITY_DEFAULTS };
    }
}
async function putSecuritySettings(patch) {
    const merged = { ...(await readSettingDoc('security')) };
    const updated = [];
    if (patch.registrationEnabled !== undefined) {
        merged['registrationEnabled'] = ensureDocBool(patch.registrationEnabled, 'registrationEnabled');
        updated.push('registrationEnabled');
    }
    if (patch.captchaEnabled !== undefined) {
        merged['captchaEnabled'] = ensureDocBool(patch.captchaEnabled, 'captchaEnabled');
        updated.push('captchaEnabled');
    }
    await upsertSetting('security', merged);
    return updated;
}
