"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGoldConfig = getGoldConfig;
exports.saveGoldConfig = saveGoldConfig;
exports.parseGoldPrices = parseGoldPrices;
exports.renderGoldTemplate = renderGoldTemplate;
exports.runGoldCheck = runGoldCheck;
exports.runNow = runNow;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const errors_js_1 = require("../../core/errors.js");
const http_js_1 = require("../../core/http.js");
const outbox_js_1 = require("../../core/outbox.js");
const plan_service_js_1 = require("../subscriptions/plan.service.js");
const system_settings_service_js_1 = require("../admin/system-settings.service.js");
/**
 * Gold ticker (§29): scheduled price scraping / API integration → tolerant parser → snapshot →
 * optional publish through the tenant's ACTIVE channels. Gated by the plan
 * feature gold_ticker. SSRF-guarded fetch on every run (§60) since sourceUrl
 * is user-influenced.
 * Supports Bearer API tokens (24tala.ir, Navasan, etc.) and fallback web-scraping.
 */
const DEFAULT_SOURCE_URL = 'https://www.tgju.org';
const DEFAULT_TEMPLATE = '🪙 نرخ لحظه‌ای طلا، سکه و ارز:\n\n' +
    'طلای ۱۸ عیار: {طلای ۱۸ عیار} تومان\n' +
    'سکه امامی: {سکه امامی} تومان\n' +
    'دلار: {دلار} تومان\n\n' +
    'توسط ربات پُست‌یار';
async function requireGoldFeature(tenantId) {
    const ctx = await (0, plan_service_js_1.getPlanContext)(tenantId);
    if (!ctx.features.gold_ticker) {
        throw new errors_js_1.AppError({ ...errors_js_1.ERR.FORBIDDEN(), message: 'ماژول طلا در پلن فعلی شما فعال نیست.' });
    }
}
function toDto(row) {
    return {
        id: row.id,
        tenantId: row.tenantId,
        sourceUrl: row.sourceUrl,
        apiToken: row.apiToken ?? null,
        templateText: row.templateText,
        channelIds: Array.isArray(row.channelIds) ? row.channelIds : [],
        frequencyMinutes: row.frequencyMinutes,
        timezone: row.timezone,
        changeOnly: row.changeOnly === 1,
        isEnabled: row.isEnabled === 1,
        lastSnapshot: row.lastSnapshotJson ?? null,
        lastRunAt: row.lastRunAt,
    };
}
async function getGoldConfig(tenantId) {
    await requireGoldFeature(tenantId);
    const db = (0, client_js_1.getDb)();
    const [row] = await db.select().from(schema_js_1.goldConfigs).where((0, drizzle_orm_1.eq)(schema_js_1.goldConfigs.tenantId, tenantId)).limit(1);
    if (row)
        return toDto(row); // existing rows keep their own values — unchanged behavior
    // Lazy default row so the settings form is immediately editable.
    // Round 18: the admin-configured defaults (system_settings key 'gold') win
    // when non-empty; otherwise the built-in constants below apply.
    let sourceUrl = DEFAULT_SOURCE_URL;
    let template = DEFAULT_TEMPLATE;
    let frequencyMinutes = 60;
    let apiToken = null;
    try {
        const admin = await (0, system_settings_service_js_1.getGoldSettings)();
        if (admin.defaultSourceUrl !== '')
            sourceUrl = admin.defaultSourceUrl;
        if (admin.defaultTemplateFa !== '')
            template = admin.defaultTemplateFa;
        if (admin.apiToken !== '')
            apiToken = admin.apiToken;
        frequencyMinutes = admin.defaultFrequencyMinutes;
    }
    catch {
        // settings read failure → built-in defaults (never block the user form)
    }
    const id = (0, ids_js_1.newId)();
    await db.insert(schema_js_1.goldConfigs).values({
        id,
        tenantId,
        sourceUrl,
        apiToken,
        templateText: template,
        channelIds: [],
        frequencyMinutes,
        timezone: 'Asia/Tehran',
        changeOnly: 1,
        isEnabled: 0,
    });
    const [created] = await db.select().from(schema_js_1.goldConfigs).where((0, drizzle_orm_1.eq)(schema_js_1.goldConfigs.tenantId, tenantId)).limit(1);
    if (!created)
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    return toDto(created);
}
async function saveGoldConfig(tenantId, input) {
    await requireGoldFeature(tenantId);
    const db = (0, client_js_1.getDb)();
    if (input.frequencyMinutes < 15) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('فاصلهٔ به‌روزرسانی نباید کمتر از ۱۵ دقیقه باشد.'));
    }
    // Save-time SSRF validation; the fetch re-validates on every run (DNS rebinding).
    if (input.sourceUrl && input.sourceUrl.trim()) {
        await (0, http_js_1.assertSafeUrl)(input.sourceUrl.trim());
    }
    const uniqueChannelIds = [...new Set(input.channelIds)];
    if (uniqueChannelIds.length > 0) {
        const rows = await db
            .select({ id: schema_js_1.channels.id })
            .from(schema_js_1.channels)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.inArray)(schema_js_1.channels.id, uniqueChannelIds)));
        if (rows.length !== uniqueChannelIds.length) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('یکی از کانال‌های انتخاب‌شده معتبر نیست.'));
        }
    }
    const [existing] = await db.select().from(schema_js_1.goldConfigs).where((0, drizzle_orm_1.eq)(schema_js_1.goldConfigs.tenantId, tenantId)).limit(1);
    const values = {
        sourceUrl: input.sourceUrl,
        apiToken: input.apiToken !== undefined ? (input.apiToken ? input.apiToken.trim() : null) : undefined,
        templateText: input.templateText,
        channelIds: uniqueChannelIds,
        frequencyMinutes: input.frequencyMinutes,
        timezone: input.timezone || 'Asia/Tehran',
        changeOnly: input.changeOnly ? 1 : 0,
        isEnabled: input.isEnabled ? 1 : 0,
    };
    if (existing) {
        await db.update(schema_js_1.goldConfigs).set(values).where((0, drizzle_orm_1.eq)(schema_js_1.goldConfigs.id, existing.id));
    }
    else {
        await db.insert(schema_js_1.goldConfigs).values({ id: (0, ids_js_1.newId)(), tenantId, ...values });
    }
    const [row] = await db.select().from(schema_js_1.goldConfigs).where((0, drizzle_orm_1.eq)(schema_js_1.goldConfigs.tenantId, tenantId)).limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    return toDto(row);
}
// ---- tolerant price parser & JSON API extractor -----------------------------
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
function normalizeDigits(input) {
    return input.replace(/[۰-۹٠-٩]/g, (d) => {
        const p = PERSIAN_DIGITS.indexOf(d);
        if (p >= 0)
            return String(p);
        return String(ARABIC_DIGITS.indexOf(d));
    });
}
/** Label detection rules — order matters (specific before generic). */
const LABEL_RULES = [
    { re: /سکه\s*امامی|طرح\s*جدید/, label: 'سکه امامی' },
    { re: /سکه\s*بهار|طرح\s*قدیم/, label: 'سکه بهار آزادی' },
    { re: /نیم\s*سکه|سکه\s*نیم/, label: 'نیم سکه' },
    { re: /ربع\s*سکه|سکه\s*ربع/, label: 'ربع سکه' },
    { re: /سکه\s*گرمی|گرمی/, label: 'سکه گرمی' },
    { re: /سکه/, label: 'سکه' },
    { re: /طلای\s*18|عِیار\s*18|عیار\s*18|18\s*عیار|گرمی\s*18|طلا18|طلا\s*18/, label: 'طلای ۱۸ عیار' },
    { re: /طلای\s*24|عیار\s*24|24\s*عیار/, label: 'طلای ۲۴ عیار' },
    { re: /انس\s*طلا|انس\s*جهانی|انس/, label: 'انس جهانی' },
    { re: /دلار|تتر|usdt|usd/i, label: 'دلار' },
    { re: /یورو|eur/i, label: 'یورو' },
    { re: /درهم|aed/i, label: 'درهم' },
    { re: /لیر|try/i, label: 'لیر' },
    { re: /پوند|gbp/i, label: 'پوند' },
    { re: /گرم\s*طلا|طلای\s*گرم/, label: 'طلای گرم' },
];
/** Standard English symbol to Persian label mapping (e.g. for 24tala, Navasan, etc.) */
const SYMBOL_TO_LABEL = {
    IR_GOLD_18K: 'طلای ۱۸ عیار',
    GOLD_18K: 'طلای ۱۸ عیار',
    GOLD_18: 'طلای ۱۸ عیار',
    GOLD18: 'طلای ۱۸ عیار',
    GERAM18: 'طلای ۱۸ عیار',
    TALA18: 'طلای ۱۸ عیار',
    TALA_18: 'طلای ۱۸ عیار',
    '18AYAR': 'طلای ۱۸ عیار',
    GOLD: 'طلای ۱۸ عیار',
    TALA: 'طلای ۱۸ عیار',
    IR_GOLD_24K: 'طلای ۲۴ عیار',
    GOLD_24K: 'طلای ۲۴ عیار',
    SEKE_EMAMI: 'سکه امامی',
    SEKEE: 'سکه امامی',
    EMAMI: 'سکه امامی',
    SEKE_BAHAR: 'سکه بهار آزادی',
    BAHAR: 'سکه بهار آزادی',
    SEKE_NIM: 'نیم سکه',
    NIM: 'نیم سکه',
    SEKE_ROB: 'ربع سکه',
    ROB: 'ربع سکه',
    SEKE_GERMI: 'سکه گرمی',
    GERMI: 'سکه گرمی',
    SEKE: 'سکه',
    USD: 'دلار',
    DOLLAR: 'دلار',
    USDT: 'تتر',
    EUR: 'یورو',
    EURO: 'یورو',
    AED: 'درهم',
    DIRHAM: 'درهم',
    TRY: 'لیر',
    LIRA: 'لیر',
    GBP: 'پوند',
    POUND: 'پوند',
    ONS: 'انس جهانی',
    OUNCE: 'انس جهانی',
    XAU: 'انس جهانی',
};
function matchLabelFromAny(keyOrName) {
    if (!keyOrName || typeof keyOrName !== 'string')
        return null;
    const upper = keyOrName.trim().toUpperCase().replace(/[\s\-_]/g, '_');
    if (SYMBOL_TO_LABEL[upper])
        return SYMBOL_TO_LABEL[upper];
    // Try direct Persian regex check
    const norm = normalizeDigits(keyOrName);
    const rule = LABEL_RULES.find((r) => r.re.test(norm));
    if (rule)
        return rule.label;
    // Substring matching for known identifiers
    for (const [sym, label] of Object.entries(SYMBOL_TO_LABEL)) {
        if (upper === sym || upper.includes(sym))
            return label;
    }
    return null;
}
function extractNumber(line) {
    const match = line.match(/(\d[\d,،٬./\s]*\d|\d)/);
    const captured = match?.[1];
    if (!captured)
        return null;
    let raw = captured.replace(/[\s,،٬]/g, '');
    if (raw.includes('/') && !raw.includes('.'))
        raw = raw.replace(/\//g, '.');
    const dots = (raw.match(/\./g) ?? []).length;
    if (dots > 1) {
        const parts = raw.split('.');
        const last = parts.pop() ?? '';
        raw = parts.join('') + (last.length <= 2 ? `.${last}` : last);
    }
    else if (dots === 1) {
        const [intPart, fracPart = ''] = raw.split('.');
        if (fracPart.length > 2)
            raw = intPart + fracPart; // likely a thousands dot
    }
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
}
function parseNumericValue(val) {
    if (typeof val === 'number') {
        return Number.isFinite(val) && val > 0 ? val : null;
    }
    if (typeof val === 'string') {
        return extractNumber(normalizeDigits(val));
    }
    if (val && typeof val === 'object') {
        const obj = val;
        for (const prop of ['price', 'value', 'val', 'current', 'p', 'rate', 'last', 'amount', 'sell', 'close']) {
            if (obj[prop] !== undefined) {
                const parsed = parseNumericValue(obj[prop]);
                if (parsed !== null)
                    return parsed;
            }
        }
    }
    return null;
}
function extractPricesFromJson(data) {
    if (!data || typeof data !== 'object')
        return [];
    const out = [];
    const seen = new Set();
    const addPrice = (label, value) => {
        if (!label || value === null || value <= 0 || seen.has(label))
            return;
        seen.add(label);
        out.push({ label, value });
    };
    let list = null;
    if (Array.isArray(data)) {
        list = data;
    }
    else {
        const obj = data;
        for (const key of ['rates', 'data', 'items', 'result', 'prices', 'list', 'currencies']) {
            if (Array.isArray(obj[key])) {
                list = obj[key];
                break;
            }
        }
    }
    if (list) {
        for (const item of list) {
            if (!item || typeof item !== 'object')
                continue;
            const row = item;
            const candidate = String(row.symbol || row.name || row.title || row.label || row.key || row.id || row.slug || '');
            const label = matchLabelFromAny(candidate) || (row.name ? matchLabelFromAny(String(row.name)) : null);
            const value = parseNumericValue(row.price ?? row.value ?? row.val ?? row.current ?? row.rate ?? row.last ?? row);
            addPrice(label, value);
        }
    }
    else {
        const obj = (typeof data.data === 'object' &&
            data.data !== null &&
            !Array.isArray(data.data))
            ? data.data
            : data;
        for (const [key, val] of Object.entries(obj)) {
            const label = matchLabelFromAny(key);
            const value = parseNumericValue(val);
            addPrice(label, value);
        }
    }
    return out;
}
/** Tolerant parser: JSON API formats (24tala, etc.), Persian/Arabic digits, HTML scrape fallback. */
function parseGoldPrices(input) {
    if (!input || typeof input !== 'string')
        return [];
    // 1. Try parsing structured JSON first (24tala.ir API v1/v2, etc.)
    const trimmed = input.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            const jsonPrices = extractPricesFromJson(parsed);
            if (jsonPrices.length > 0) {
                return jsonPrices;
            }
        }
        catch {
            // JSON parse error -> fall through to text/HTML parser
        }
    }
    // 2. HTML and plain-text fallback scraping
    const text = input
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, '\n');
    const lines = normalizeDigits(text).split(/\r?\n|\u2028/);
    const out = [];
    const seen = new Set();
    for (const line of lines) {
        const rule = LABEL_RULES.find((r) => r.re.test(line));
        if (!rule)
            continue;
        if (seen.has(rule.label))
            continue;
        const value = extractNumber(line.replace(rule.re, ' '));
        if (value === null)
            continue;
        seen.add(rule.label);
        out.push({ label: rule.label, value });
        if (out.length >= 12)
            break;
    }
    return out;
}
function convertToToman(label, val) {
    if (!val || typeof val !== 'number' || val <= 0)
        return val;
    if (/انس|ounce|بیت|اتریوم|crypto/i.test(label))
        return val;
    if (/طلای|طلا|مثقال/i.test(label))
        return val > 20000000 ? Math.round(val / 10) : val;
    if (/سکه\s*امامی|تمام\s*سکه|بهار\s*آزادی|طرح\s*قدیم/i.test(label))
        return val > 150000000 ? Math.round(val / 10) : val;
    if (/نیم\s*سکه|ربع\s*سکه|سکه\s*گرمی/i.test(label))
        return val > 40000000 ? Math.round(val / 10) : val;
    if (/دلار|یورو|پوند/i.test(label))
        return val > 200000 ? Math.round(val / 10) : val;
    if (/درهم|لیر/i.test(label))
        return val > 40000 ? Math.round(val / 10) : val;
    return val > 500000 ? Math.round(val / 10) : val;
}
function toPersianNumber(value) {
    const formatted = Number.isInteger(value)
        ? value.toLocaleString('en-US')
        : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return formatted.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d);
}
/** Replace {label} / {{label}} placeholders; unknown placeholders are removed. Supports Toman conversion and common aliases. */
function renderGoldTemplate(template, prices) {
    let out = template;
    for (const price of prices) {
        const rawVal = price.value;
        const tomanVal = convertToToman(price.label, rawVal);
        const formattedToman = toPersianNumber(tomanVal);
        const formattedRial = toPersianNumber(rawVal);
        // Default tag produces TOMAN (standard in Iranian gold/currency channels)
        out = out.split(`{{${price.label}}}`).join(formattedToman);
        out = out.split(`{${price.label}}`).join(formattedToman);
        // Explicit tags
        out = out.split(`{{${price.label} (تومان)}}`).join(formattedToman);
        out = out.split(`{${price.label} (تومان)}`).join(formattedToman);
        out = out.split(`{{${price.label} به تومان}}`).join(formattedToman);
        out = out.split(`{${price.label} به تومان}`).join(formattedToman);
        out = out.split(`{{${price.label} (ریال)}}`).join(formattedRial);
        out = out.split(`{${price.label} (ریال)}`).join(formattedRial);
        out = out.split(`{{${price.label} به ریال}}`).join(formattedRial);
        out = out.split(`{${price.label} به ریال}`).join(formattedRial);
        // Support convenient shorthand template aliases
        if (price.label === 'طلای ۱۸ عیار') {
            ['طلای ۱۸', 'طلا ۱۸', 'طلا'].forEach((alias) => {
                out = out.split(`{{${alias}}}`).join(formattedToman);
                out = out.split(`{${alias}}`).join(formattedToman);
                out = out.split(`{{${alias} (تومان)}}`).join(formattedToman);
                out = out.split(`{${alias} (تومان)}`).join(formattedToman);
                out = out.split(`{{${alias} (ریال)}}`).join(formattedRial);
                out = out.split(`{${alias} (ریال)}`).join(formattedRial);
            });
        }
        else if (price.label === 'سکه امامی') {
            out = out.split('{{سکه}}').join(formattedToman);
            out = out.split('{سکه}').join(formattedToman);
            out = out.split('{{سکه (تومان)}}').join(formattedToman);
            out = out.split('{سکه (تومان)}').join(formattedToman);
            out = out.split('{{سکه (ریال)}}').join(formattedRial);
            out = out.split('{سکه (ریال)}').join(formattedRial);
        }
    }
    return out.replace(/\{\{?[^{}\n]+\}?\}/g, '').trim();
}
// ---- run -------------------------------------------------------------------
async function runGoldCheck(configId) {
    const db = (0, client_js_1.getDb)();
    const [config] = await db.select().from(schema_js_1.goldConfigs).where((0, drizzle_orm_1.eq)(schema_js_1.goldConfigs.id, configId)).limit(1);
    if (!config)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پیکربندی طلا'));
    const result = {
        configId,
        ok: false,
        changed: false,
        published: false,
        postId: null,
        prices: [],
        message: null,
    };
    try {
        let sourceUrl = config.sourceUrl?.trim() || '';
        let apiToken = config.apiToken?.trim() || '';
        if (!sourceUrl || !apiToken) {
            try {
                const admin = await (0, system_settings_service_js_1.getGoldSettings)();
                if (!sourceUrl && admin.defaultSourceUrl)
                    sourceUrl = admin.defaultSourceUrl.trim();
                if (!apiToken && admin.apiToken)
                    apiToken = admin.apiToken.trim();
            }
            catch {
                // Fall back gracefully without admin settings
            }
        }
        if (!sourceUrl)
            sourceUrl = DEFAULT_SOURCE_URL;
        const headers = {
            Accept: 'application/json, text/html, text/plain, */*',
            'User-Agent': 'PostYar-GoldTicker/1.0 (+https://postyarhub.ir)',
        };
        if (apiToken) {
            headers.Authorization = apiToken.startsWith('Bearer ') ? apiToken : `Bearer ${apiToken}`;
        }
        const res = await (0, http_js_1.httpRaw)(sourceUrl, { ssrfGuard: true, timeoutMs: 15_000, headers });
        if (res.status >= 400) {
            result.message = `دریافت اطلاعات از منبع با خطای کد ${res.status} ناموفق بود.`;
            return result;
        }
        const prices = parseGoldPrices(res.body);
        if (prices.length === 0) {
            result.message = 'هیچ قیمتی از منبع استخراج نشد. لطفاً ساختار منبع یا توکن را بررسی کنید.';
            return result;
        }
        result.prices = prices;
        const contentHash = await (0, ids_js_1.sha256Hex)(JSON.stringify(prices));
        // Serialize scheduler/manual executions on the gold config row.
        await db.transaction(async (tx) => {
            const [lockedConfig] = await tx
                .select()
                .from(schema_js_1.goldConfigs)
                .where((0, drizzle_orm_1.eq)(schema_js_1.goldConfigs.id, configId))
                .limit(1)
                .for('update');
            if (!lockedConfig)
                throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پیکربندی طلا'));
            const [last] = await tx
                .select({ contentHash: schema_js_1.goldSnapshots.contentHash })
                .from(schema_js_1.goldSnapshots)
                .where((0, drizzle_orm_1.eq)(schema_js_1.goldSnapshots.configId, configId))
                .orderBy((0, drizzle_orm_1.desc)(schema_js_1.goldSnapshots.capturedAt))
                .limit(1);
            const changed = !last || last.contentHash !== contentHash;
            result.changed = changed;
            const willPublish = (changed || lockedConfig.changeOnly !== 1) && lockedConfig.isEnabled === 1 && lockedConfig.channelIds.length > 0;
            if (willPublish) {
                const activeChannels = await tx
                    .select({ id: schema_js_1.channels.id })
                    .from(schema_js_1.channels)
                    .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, lockedConfig.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE'), (0, drizzle_orm_1.inArray)(schema_js_1.channels.id, lockedConfig.channelIds)));
                if (activeChannels.length > 0) {
                    const postId = (0, ids_js_1.newId)();
                    const body = renderGoldTemplate(lockedConfig.templateText, prices);
                    await tx.insert(schema_js_1.posts).values({
                        id: postId,
                        tenantId: lockedConfig.tenantId,
                        title: 'نرخ لحظه‌ای طلا و سکه',
                        body,
                        parseMode: 'NONE',
                        source: 'GOLD',
                        state: 'QUEUED',
                    });
                    for (const channel of activeChannels) {
                        await tx.insert(schema_js_1.postTargets).values({
                            id: (0, ids_js_1.newId)(),
                            postId,
                            tenantId: lockedConfig.tenantId,
                            channelId: channel.id,
                            state: 'PENDING',
                        });
                    }
                    await tx.insert(schema_js_1.outboxEvents).values((0, outbox_js_1.outboxRow)({ aggregateType: 'post', aggregateId: postId, eventType: 'post.publish', payload: {} }));
                    result.published = true;
                    result.postId = postId;
                }
            }
            await tx.insert(schema_js_1.goldSnapshots).values({
                id: (0, ids_js_1.newId)(),
                configId,
                pricesJson: prices,
                contentHash,
                published: result.published ? 1 : 0,
            });
            await tx
                .update(schema_js_1.goldConfigs)
                .set({ lastRunAt: new Date(), lastSnapshotJson: prices })
                .where((0, drizzle_orm_1.eq)(schema_js_1.goldConfigs.id, configId));
        });
        result.ok = true;
        return result;
    }
    catch (err) {
        result.message = err instanceof errors_js_1.AppError ? err.userMessage : 'بررسی نرخ طلا و سکه ناموفق بود.';
        await db
            .update(schema_js_1.goldConfigs)
            .set({ lastRunAt: new Date() })
            .where((0, drizzle_orm_1.eq)(schema_js_1.goldConfigs.id, configId))
            .catch(() => undefined);
        return result;
    }
}
async function runNow(tenantId) {
    const config = await getGoldConfig(tenantId);
    return runGoldCheck(config.id);
}
