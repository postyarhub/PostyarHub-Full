"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAYMENT_SETTING_KEYS = void 0;
exports.getPaymentSettings = getPaymentSettings;
exports.putPaymentSettings = putPaymentSettings;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const errors_js_1 = require("../../core/errors.js");
exports.PAYMENT_SETTING_KEYS = [
    'paymentOnlineEnabled',
    'paymentCardToCardEnabled',
    'paymentProvider',
    'paymentGateways',
    'cardToCardCards',
];
const DEFAULTS = {
    onlineEnabled: false,
    cardToCardEnabled: true,
    provider: 'zibal',
    cards: [],
};
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Accepts native JSON booleans and the {enabled:bool} wrapper (legacy admin page). */
function coerceBool(value, fallback) {
    if (typeof value === 'boolean')
        return value;
    if (isRecord(value) && typeof value['enabled'] === 'boolean')
        return value['enabled'];
    return fallback;
}
function coerceProvider(value, fallback) {
    if (typeof value === 'string' && value.trim() !== '')
        return value.trim();
    if (isRecord(value) && typeof value['provider'] === 'string' && value['provider'].trim() !== '') {
        return value['provider'].trim();
    }
    return fallback;
}
function coerceCards(value, fallback) {
    const raw = Array.isArray(value)
        ? value
        : isRecord(value) && Array.isArray(value['cards'])
            ? value['cards']
            : null;
    if (!raw)
        return fallback;
    const cards = [];
    for (const item of raw.slice(0, 5)) {
        if (!isRecord(item))
            continue;
        const bankName = typeof item['bankName'] === 'string' ? item['bankName'].trim() : '';
        const cardNumber = typeof item['cardNumber'] === 'string' ? item['cardNumber'].trim() : '';
        const holderName = typeof item['holderName'] === 'string' ? item['holderName'].trim() : '';
        if (!bankName || !cardNumber || !holderName)
            continue;
        cards.push({
            id: typeof item['id'] === 'string' && item['id'].trim() !== '' ? item['id'].trim() : (0, ids_js_1.newId)(),
            bankName,
            cardNumber,
            holderName,
        });
    }
    return cards;
}
// ---------------------------------------------------------------------------
// Gateway credentials (per-provider, stored under the 'paymentGateways' key).
// Read: defaults merged with stored (stored wins), unknown providers dropped.
// ---------------------------------------------------------------------------
function defaultGatewayConfigs() {
    return {
        zibal: { merchantId: '', sandbox: true },
        zarinpal: { merchantId: '', sandbox: true },
        idpay: { apiKey: '', sandbox: true },
        winapay: { merchantId: '', sandbox: false },
    };
}
function mergeGatewayConfigs(stored) {
    const merged = defaultGatewayConfigs();
    if (!isRecord(stored))
        return merged;
    const zibal = isRecord(stored['zibal']) ? stored['zibal'] : undefined;
    if (zibal) {
        if (typeof zibal['merchantId'] === 'string')
            merged.zibal.merchantId = zibal['merchantId'].slice(0, 128);
        if (typeof zibal['sandbox'] === 'boolean')
            merged.zibal.sandbox = zibal['sandbox'];
    }
    const zarinpal = isRecord(stored['zarinpal']) ? stored['zarinpal'] : undefined;
    if (zarinpal) {
        if (typeof zarinpal['merchantId'] === 'string')
            merged.zarinpal.merchantId = zarinpal['merchantId'].slice(0, 128);
        if (typeof zarinpal['sandbox'] === 'boolean')
            merged.zarinpal.sandbox = zarinpal['sandbox'];
    }
    const winapay = isRecord(stored['winapay']) ? stored['winapay'] : undefined;
    if (winapay) {
        if (typeof winapay['merchantId'] === 'string')
            merged.winapay.merchantId = winapay['merchantId'].slice(0, 128);
    }
    const idpay = isRecord(stored['idpay']) ? stored['idpay'] : undefined;
    if (idpay) {
        if (typeof idpay['apiKey'] === 'string')
            merged.idpay.apiKey = idpay['apiKey'].slice(0, 128);
        if (typeof idpay['sandbox'] === 'boolean')
            merged.idpay.sandbox = idpay['sandbox'];
    }
    return merged;
}
/** Strict credential validation — numbers never coerce to strings. */
function ensureCredField(value, field) {
    if (typeof value !== 'string') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`مقدار «${field}» باید متن باشد.`));
    }
    if (value.trim().length > 128) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`مقدار «${field}» بیش از حد مجاز است.`));
    }
    return value.trim();
}
function ensureSandbox(value) {
    if (typeof value !== 'boolean') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مقدار «sandbox» باید بولی باشد.'));
    }
    return value;
}
function applyGatewayPatch(current, patch) {
    const merged = {
        zibal: { ...current.zibal },
        zarinpal: { ...current.zarinpal },
        idpay: { ...current.idpay },
        winapay: { ...current.winapay, sandbox: false },
    };
    if (patch.zibal) {
        if (patch.zibal.merchantId !== undefined)
            merged.zibal.merchantId = ensureCredField(patch.zibal.merchantId, 'merchantId');
        if (patch.zibal.sandbox !== undefined)
            merged.zibal.sandbox = ensureSandbox(patch.zibal.sandbox);
    }
    if (patch.zarinpal) {
        if (patch.zarinpal.merchantId !== undefined)
            merged.zarinpal.merchantId = ensureCredField(patch.zarinpal.merchantId, 'merchantId');
        if (patch.zarinpal.sandbox !== undefined)
            merged.zarinpal.sandbox = ensureSandbox(patch.zarinpal.sandbox);
    }
    if (patch.winapay) {
        if (patch.winapay.merchantId !== undefined)
            merged.winapay.merchantId = ensureCredField(patch.winapay.merchantId, 'merchantId');
        merged.winapay.sandbox = false;
    }
    if (patch.idpay) {
        if (patch.idpay.apiKey !== undefined)
            merged.idpay.apiKey = ensureCredField(patch.idpay.apiKey, 'apiKey');
        if (patch.idpay.sandbox !== undefined)
            merged.idpay.sandbox = ensureSandbox(patch.idpay.sandbox);
    }
    return merged;
}
async function getPaymentSettings() {
    const db = (0, client_js_1.getDb)();
    const rows = await db
        .select({ settingKey: schema_js_1.systemSettings.settingKey, valueJson: schema_js_1.systemSettings.valueJson })
        .from(schema_js_1.systemSettings)
        .where((0, drizzle_orm_1.inArray)(schema_js_1.systemSettings.settingKey, [...exports.PAYMENT_SETTING_KEYS]));
    const snapshot = { ...DEFAULTS, gateways: defaultGatewayConfigs() };
    for (const row of rows) {
        switch (row.settingKey) {
            case 'paymentOnlineEnabled':
                snapshot.onlineEnabled = coerceBool(row.valueJson, DEFAULTS.onlineEnabled);
                break;
            case 'paymentCardToCardEnabled':
                snapshot.cardToCardEnabled = coerceBool(row.valueJson, DEFAULTS.cardToCardEnabled);
                break;
            case 'paymentProvider':
                snapshot.provider = coerceProvider(row.valueJson, DEFAULTS.provider);
                if (!['zibal', 'zarinpal', 'idpay', 'winapay'].includes(snapshot.provider)) {
                    snapshot.provider = DEFAULTS.provider;
                }
                break;
            case 'paymentGateways':
                snapshot.gateways = mergeGatewayConfigs(row.valueJson);
                break;
            case 'cardToCardCards':
                snapshot.cards = coerceCards(row.valueJson, DEFAULTS.cards);
                break;
        }
    }
    // Online payment is effective only when the selected provider has a usable
    // credential. This prevents the wallet UI/API from advertising a gateway
    // that will inevitably fail with "gateway not configured".
    const configured = (() => {
        switch (snapshot.provider) {
            case 'idpay':
                return snapshot.gateways.idpay.apiKey.trim() !== '';
            case 'zibal':
                return snapshot.gateways.zibal.merchantId.trim() !== '';
            case 'zarinpal':
                return snapshot.gateways.zarinpal.merchantId.trim() !== '';
            case 'winapay':
                return snapshot.gateways.winapay.merchantId.trim() !== '';
            default:
                return false;
        }
    })();
    snapshot.onlineEnabled = snapshot.onlineEnabled && configured;
    return snapshot;
}
async function upsertSetting(key, value) {
    const db = (0, client_js_1.getDb)();
    await db
        .insert(schema_js_1.systemSettings)
        .values({ settingKey: key, valueJson: value })
        .onDuplicateKeyUpdate({ set: { valueJson: value } });
}
/**
 * Persists only the provided keys. Returns the list of keys actually written.
 * Values are stored as native JSON documents (see module docblock); card ids
 * are generated when the admin payload omits them. The gateways patch is
 * merged per-provider over the currently stored config.
 */
async function putPaymentSettings(patch) {
    const updated = [];
    if (patch.paymentOnlineEnabled !== undefined) {
        await upsertSetting('paymentOnlineEnabled', patch.paymentOnlineEnabled);
        updated.push('paymentOnlineEnabled');
    }
    if (patch.paymentCardToCardEnabled !== undefined) {
        await upsertSetting('paymentCardToCardEnabled', patch.paymentCardToCardEnabled);
        updated.push('paymentCardToCardEnabled');
    }
    if (patch.paymentProvider !== undefined) {
        await upsertSetting('paymentProvider', patch.paymentProvider);
        updated.push('paymentProvider');
    }
    if (patch.paymentGateways !== undefined) {
        const db = (0, client_js_1.getDb)();
        const [row] = await db
            .select({ valueJson: schema_js_1.systemSettings.valueJson })
            .from(schema_js_1.systemSettings)
            .where((0, drizzle_orm_1.eq)(schema_js_1.systemSettings.settingKey, 'paymentGateways'))
            .limit(1);
        const merged = applyGatewayPatch(mergeGatewayConfigs(row?.valueJson), patch.paymentGateways);
        await upsertSetting('paymentGateways', merged);
        updated.push('paymentGateways');
    }
    if (patch.cardToCardCards !== undefined) {
        const cards = patch.cardToCardCards.map((c) => ({
            id: c.id && c.id.trim() !== '' ? c.id.trim() : (0, ids_js_1.newId)(),
            bankName: c.bankName.trim(),
            cardNumber: c.cardNumber.trim(),
            holderName: c.holderName.trim(),
        }));
        await upsertSetting('cardToCardCards', cards);
        updated.push('cardToCardCards');
    }
    return updated;
}
