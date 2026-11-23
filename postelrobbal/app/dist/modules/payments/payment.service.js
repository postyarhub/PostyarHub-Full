"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.POINT_TO_RIAL = void 0;
exports.gatewayFor = gatewayFor;
exports.createSubscriptionPayment = createSubscriptionPayment;
exports.createSubscriptionIntent = createSubscriptionIntent;
exports.attachReceipt = attachReceipt;
exports.createWalletTopup = createWalletTopup;
exports.referralHookFirstPurchase = referralHookFirstPurchase;
exports.handleCallback = handleCallback;
exports.listPayments = listPayments;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const ids_js_1 = require("../../core/ids.js");
const idempotency_js_1 = require("../../core/idempotency.js");
const events_js_1 = require("../../core/events.js");
const audit_js_1 = require("../../core/audit.js");
const env_js_1 = require("../../config/env.js");
const zarinpal_js_1 = require("../../providers/payments/zarinpal.js");
const zibal_js_1 = require("../../providers/payments/zibal.js");
const idpay_js_1 = require("../../providers/payments/idpay.js");
const winapay_js_1 = require("../../providers/payments/winapay.js");
const plan_service_js_1 = require("../subscriptions/plan.service.js");
const wallet_service_js_1 = require("../wallet/wallet.service.js");
const payment_settings_service_js_1 = require("./payment-settings.service.js");
const system_settings_service_js_1 = require("../admin/system-settings.service.js");
exports.POINT_TO_RIAL = 10; // ۱ امتیاز = ۱۰ ریال
const WALLET_TOPUP_MIN = 100_000; // Rial
const ONLINE_PROVIDERS = ['zibal', 'zarinpal', 'idpay', 'winapay'];
/**
 * Resolves the active gateway from the admin-configured settings. The env
 * PAYMENT_MERCHANT_ID stays as a fallback for zibal/zarinpal so legacy deploys
 * keep working; idpay has no env fallback (panel-issued API key only).
 */
function resolveGateway(provider, settings) {
    const env = (0, env_js_1.loadEnv)();
    const sandboxDefault = env.NODE_ENV !== 'production';
    const envMerchant = (env.PAYMENT_MERCHANT_ID ?? '').trim();
    switch (provider) {
        case 'zibal': {
            const cfg = settings.gateways.zibal;
            return {
                provider: 'zibal',
                credential: (cfg.merchantId || envMerchant).trim(),
                sandbox: cfg.sandbox ?? sandboxDefault,
            };
        }
        case 'idpay': {
            const cfg = settings.gateways.idpay;
            return { provider: 'idpay', credential: cfg.apiKey.trim(), sandbox: cfg.sandbox ?? sandboxDefault };
        }
        case 'winapay': {
            const cfg = settings.gateways.winapay;
            return { provider: 'winapay', credential: cfg.merchantId.trim(), sandbox: false };
        }
        default: {
            const cfg = settings.gateways.zarinpal;
            return {
                provider: 'zarinpal',
                credential: (cfg.merchantId || envMerchant).trim(),
                sandbox: cfg.sandbox ?? sandboxDefault,
            };
        }
    }
}
/**
 * Async gateway factory (settings-driven; admin-panel v2).
 * Reads the admin-configured provider + credentials and returns the matching
 * adapter. An optional `hint` (the payment's stored gateway column) pins the
 * adapter to the provider that created the payment, so a provider switch
 * between creation and callback cannot break verification.
 * Guard: when the resolved credential is empty and there is no usable fallback
 * (zibal sandbox may degrade to the public test merchant 'zibal'), throw the
 * stable Persian GATEWAY_NOT_CONFIGURED — before any IO or DB write.
 */
async function gatewayFor(hint) {
    const settings = await (0, payment_settings_service_js_1.getPaymentSettings)();
    const provider = hint && ONLINE_PROVIDERS.includes(hint) ? hint : settings.provider;
    const resolved = resolveGateway(provider, settings);
    const unconfigured = !resolved.credential && !(resolved.provider === 'zibal' && resolved.sandbox);
    if (unconfigured)
        throw new errors_js_1.AppError(errors_js_1.ERR.GATEWAY_NOT_CONFIGURED());
    switch (resolved.provider) {
        case 'zibal':
            return new zibal_js_1.ZibalAdapter(resolved.credential, resolved.sandbox);
        case 'idpay':
            return new idpay_js_1.IdpayAdapter(resolved.credential, resolved.sandbox);
        case 'winapay':
            return new winapay_js_1.WinaPayAdapter(resolved.credential);
        default:
            return new zarinpal_js_1.ZarinpalAdapter(resolved.credential, resolved.sandbox);
    }
}
async function createPaymentRow(input) {
    const db = (0, client_js_1.getDb)();
    const env = (0, env_js_1.loadEnv)();
    const id = (0, ids_js_1.newId)();
    const gw = await gatewayFor();
    let chargeAmountRial = input.amountRial;
    let persistedMeta = input.metaJson;
    if (gw.id === 'winapay') {
        if (input.purpose === 'WALLET_TOPUP' && chargeAmountRial % 10 !== 0) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای پرداخت ویناپی، مبلغ شارژ باید مضربی از ۱۰ ریال باشد.'));
        }
        if (input.purpose === 'SUBSCRIPTION') {
            // WinaPay accepts whole Toman only. Store, verify, credit and display the
            // exact Rial amount that the gateway actually charges, never the
            // pre-rounded amount that would cause a payment/ledger mismatch.
            chargeAmountRial = Math.floor(chargeAmountRial / 10) * 10;
            if (chargeAmountRial < 1_000) {
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('حداقل مبلغ قابل پرداخت با ویناپی ۱۰۰ تومان است.'));
            }
            const adjustment = input.amountRial - chargeAmountRial;
            if (adjustment > 0) {
                const meta = { ...(input.metaJson ?? {}), providerRoundingAdjustmentRial: adjustment };
                const pricing = meta['pricing'];
                if (pricing && typeof pricing === 'object' && !Array.isArray(pricing)) {
                    const p = pricing;
                    const listAmount = Number(p['listAmountRial'] ?? input.amountRial);
                    meta['pricing'] = {
                        ...p,
                        finalAmountRial: chargeAmountRial,
                        discountAmountRial: Math.max(0, listAmount - chargeAmountRial),
                        providerRoundingAdjustmentRial: adjustment,
                    };
                }
                persistedMeta = meta;
            }
        }
    }
    const created = await gw.createPayment({
        amountRial: chargeAmountRial,
        description: input.description,
        callbackUrl: `${env.API_URL}/api/v1/payments/callback?paymentId=${id}`,
    });
    await db.insert(schema_js_1.payments).values({
        id,
        tenantId: input.tenantId,
        purpose: input.purpose,
        planId: input.planId,
        months: input.months,
        amountRial: chargeAmountRial,
        gateway: gw.id,
        authority: created.authority,
        state: 'CREATED',
        metaJson: persistedMeta,
    });
    await (0, events_js_1.emitEvent)({
        name: 'payment.created',
        tenantId: input.tenantId,
        subjectType: 'payment',
        subjectId: id,
        props: { purpose: input.purpose, amountRial: chargeAmountRial },
    });
    return { paymentId: id, redirectUrl: created.redirectUrl };
}
/**
 * Subscription purchase payment (plan must be active; free plan has no checkout).
 * Round 19: the chargeable amount is the plan's list price × months minus the
 * applicable discounts (duration discount always; renewal/upgrade discount
 * when the buyer still has an unexpired subscription). The full breakdown is
 * persisted in payments.meta_json for the admin payment popup.
 */
async function createSubscriptionPayment(tenantId, planCode, months) {
    const db = (0, client_js_1.getDb)();
    const [plan] = await db
        .select()
        .from(schema_js_1.plans)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.plans.code, planCode), (0, drizzle_orm_1.eq)(schema_js_1.plans.isActive, 1)))
        .limit(1);
    if (!plan)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پلن'));
    const price = (0, plan_service_js_1.computeSubscriptionPrice)(plan, months, await (0, plan_service_js_1.hasUnexpiredSubscription)(tenantId));
    if (price.listAmountRial <= 0)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('این پلن رایگان است.'));
    return createPaymentRow({
        tenantId,
        purpose: 'SUBSCRIPTION',
        planId: plan.id,
        months,
        amountRial: price.finalAmountRial,
        description: 'خرید اشتراک پُست‌یار',
        metaJson: { pricing: price },
    });
}
/** Accepts a plan id (ULID) or, for convenience, its unique code. */
async function findActivePlan(planIdOrCode) {
    const db = (0, client_js_1.getDb)();
    const [plan] = await db
        .select()
        .from(schema_js_1.plans)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.plans.isActive, 1), (0, drizzle_orm_1.or)((0, drizzle_orm_1.eq)(schema_js_1.plans.id, planIdOrCode), (0, drizzle_orm_1.eq)(schema_js_1.plans.code, planIdOrCode))))
        .limit(1);
    return plan ?? null;
}
async function createSubscriptionIntent(tenantId, input) {
    const settings = await (0, payment_settings_service_js_1.getPaymentSettings)();
    if (input.method === 'online' && !settings.onlineEnabled) {
        throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_METHOD_DISABLED());
    }
    if (input.method === 'card_to_card' && !settings.cardToCardEnabled) {
        throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_METHOD_DISABLED());
    }
    const months = input.months ?? 1;
    const plan = await findActivePlan(input.planId);
    if (!plan)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پلن'));
    // Round 19: server-authoritative discount computation (the client preview is
    // cosmetic only — the amount charged is always recomputed here).
    const price = (0, plan_service_js_1.computeSubscriptionPrice)(plan, months, await (0, plan_service_js_1.hasUnexpiredSubscription)(tenantId));
    if (price.listAmountRial <= 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('این پلن رایگان است و نیازی به پرداخت ندارد.'));
    }
    if (input.method === 'wallet') {
        const db = (0, client_js_1.getDb)();
        const paymentId = (0, ids_js_1.newId)();
        const paymentMeta = { method: 'wallet', pricing: price };
        const applied = await db.transaction(async (tx) => {
            await tx.insert(schema_js_1.payments).values({
                id: paymentId,
                tenantId,
                purpose: 'SUBSCRIPTION',
                planId: plan.id,
                months,
                amountRial: price.finalAmountRial,
                gateway: 'wallet',
                state: 'COMPLETED',
                verifiedAt: new Date(),
                metaJson: paymentMeta,
            });
            const movement = await (0, wallet_service_js_1.moveMoneyTx)(tx, tenantId, 'DEBIT', price.finalAmountRial, { type: 'payment', id: paymentId }, 'خرید اشتراک از کیف پول');
            const activated = await (0, plan_service_js_1.activateSubscriptionTx)(tx, tenantId, plan.id, months);
            await referralHookFirstPurchase(tenantId, price.finalAmountRial, tx);
            return { activated, balanceAfter: movement.balanceAfter };
        });
        if (!applied.activated?.subscriptionId)
            throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
        await (0, events_js_1.emitEvent)({
            name: 'payment.completed',
            tenantId,
            subjectType: 'payment',
            subjectId: paymentId,
            props: {
                purpose: 'SUBSCRIPTION',
                amountRial: price.finalAmountRial,
                method: 'wallet',
                subscriptionId: applied.activated.subscriptionId,
            },
        });
        await (0, events_js_1.emitEvent)({
            name: applied.activated.renewed ? 'subscription.renewed' : 'subscription.created',
            tenantId,
            subjectType: 'subscription',
            subjectId: applied.activated.subscriptionId,
            props: { planCode: applied.activated.planCode, months, renewed: applied.activated.renewed },
        });
        await (0, audit_js_1.audit)({
            action: 'payment.verified',
            actorId: tenantId,
            subjectType: 'payment',
            subjectId: paymentId,
            meta: {
                purpose: 'SUBSCRIPTION',
                amountRial: price.finalAmountRial,
                gateway: 'wallet',
                method: 'wallet',
                subscriptionId: applied.activated.subscriptionId,
            },
        });
        return {
            paymentId,
            subscriptionId: applied.activated.subscriptionId,
            balanceAfter: applied.balanceAfter,
            activated: true,
        };
    }
    if (input.method === 'online') {
        // Graceful degradation when the gateway is unconfigured (sandbox path).
        // gatewayFor() enforces the same guard without any IO — this early check
        // avoids creating the payment row when no provider is configured.
        await gatewayFor();
        const result = await createSubscriptionPayment(tenantId, plan.code, months);
        return { paymentId: result.paymentId, redirectUrl: result.redirectUrl };
    }
    // card_to_card: no gateway involved — always works.
    const db = (0, client_js_1.getDb)();
    const id = (0, ids_js_1.newId)();
    const reference = (0, ids_js_1.newId)();
    await db.insert(schema_js_1.payments).values({
        id,
        tenantId,
        purpose: 'SUBSCRIPTION',
        planId: plan.id,
        months,
        amountRial: price.finalAmountRial,
        gateway: 'card_to_card',
        reference,
        state: 'PENDING_REVIEW',
        metaJson: { method: 'card_to_card', reference, pricing: price },
    });
    await (0, events_js_1.emitEvent)({
        name: 'payment.created',
        tenantId,
        subjectType: 'payment',
        subjectId: id,
        props: { purpose: 'SUBSCRIPTION', amountRial: price.finalAmountRial, method: 'card_to_card' },
    });
    return { paymentId: id, reference, cards: settings.cards };
}
/**
 * Attaches the uploaded receipt to a PENDING_REVIEW card-to-card payment.
 * Ownership: the payment must belong to the session tenant (missing or
 * foreign payments are indistinguishable 404s — §180 no existence leak).
 * Idempotency: a second upload is rejected (the first receipt stands until
 * an admin reviews it).
 */
async function attachReceipt(tenantId, paymentId, upload) {
    const db = (0, client_js_1.getDb)();
    const [payment] = await db.select().from(schema_js_1.payments).where((0, drizzle_orm_1.eq)(schema_js_1.payments.id, paymentId)).limit(1);
    if (!payment || payment.tenantId !== tenantId)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پرداخت'));
    if (payment.receiptMediaId) {
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('رسید این پرداخت قبلاً بارگذاری شده است و قابل تغییر نیست.'));
    }
    if (payment.state !== 'PENDING_REVIEW') {
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('این پرداخت در مرحلهٔ انتظار رسید نیست.'));
    }
    const [receiptMedia] = await db
        .select({ id: schema_js_1.media.id, mime: schema_js_1.media.mime, sizeBytes: schema_js_1.media.sizeBytes })
        .from(schema_js_1.media)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.media.id, upload.mediaId), (0, drizzle_orm_1.eq)(schema_js_1.media.tenantId, tenantId)))
        .limit(1);
    if (!receiptMedia)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('رسید'));
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(receiptMedia.mime) || Number(receiptMedia.sizeBytes) > 5 * 1024 * 1024) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('فرمت یا حجم رسید معتبر نیست.'));
    }
    const metaJson = { ...(payment.metaJson ?? {}) };
    if (upload.note && upload.note.trim() !== '')
        metaJson.receiptNote = upload.note.trim().slice(0, 500);
    const res = await db
        .update(schema_js_1.payments)
        .set({ receiptMediaId: upload.mediaId, receiptNote: upload.note?.trim().slice(0, 500) || null, metaJson })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.payments.id, payment.id), (0, drizzle_orm_1.eq)(schema_js_1.payments.state, 'PENDING_REVIEW')));
    const changed = Array.isArray(res) ? Number(res[0]?.affectedRows ?? 0) : Number(res?.affectedRows ?? 0);
    if (changed === 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('رسید این پرداخت قبلاً بارگذاری شده است و قابل تغییر نیست.'));
    }
    await (0, audit_js_1.audit)({ action: 'payment.receipt_uploaded', actorId: tenantId, subjectType: 'payment', subjectId: payment.id });
    return { paymentId: payment.id, status: 'PENDING_REVIEW' };
}
/** Wallet top-up payment. When online is disabled and card-to-card is enabled,
 * the method is selected automatically. */
async function createWalletTopup(tenantId, amountRial, requestedMethod) {
    if (!Number.isInteger(amountRial) || amountRial < WALLET_TOPUP_MIN) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('حداقل مبلغ شارژ کیف پول ۱۰۰٬۰۰۰ ریال است.'));
    }
    const settings = await (0, payment_settings_service_js_1.getPaymentSettings)();
    // The wallet must remain usable when an old/cached client still posts
    // method=online while online payment is disabled or unconfigured.
    // In that situation card-to-card is the deterministic fallback.
    let method = requestedMethod ?? (settings.onlineEnabled ? 'online' : 'card_to_card');
    if (method === 'online' && !settings.onlineEnabled && settings.cardToCardEnabled && settings.cards.length > 0) {
        method = 'card_to_card';
    }
    if (method === 'online') {
        if (!settings.onlineEnabled)
            throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_METHOD_DISABLED());
        return createPaymentRow({
            tenantId,
            purpose: 'WALLET_TOPUP',
            planId: null,
            months: 1,
            amountRial,
            description: 'شارژ کیف پول پُست‌یار',
        });
    }
    if (!settings.cardToCardEnabled)
        throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_METHOD_DISABLED());
    if (settings.cards.length === 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('هنوز کارت مقصدی برای پرداخت کارت‌به‌کارت توسط مدیریت ثبت نشده است.'));
    }
    const db = (0, client_js_1.getDb)();
    const id = (0, ids_js_1.newId)();
    const reference = (0, ids_js_1.newId)();
    await db.insert(schema_js_1.payments).values({
        id,
        tenantId,
        purpose: 'WALLET_TOPUP',
        planId: null,
        months: 1,
        amountRial,
        gateway: 'card_to_card',
        reference,
        state: 'PENDING_REVIEW',
        metaJson: { method: 'card_to_card', reference },
    });
    await (0, events_js_1.emitEvent)({
        name: 'payment.created',
        tenantId,
        subjectType: 'payment',
        subjectId: id,
        props: { purpose: 'WALLET_TOPUP', amountRial, method: 'card_to_card' },
    });
    await (0, audit_js_1.audit)({ action: 'payment.created', actorId: tenantId, subjectType: 'payment', subjectId: id, meta: { method: 'card_to_card' } });
    return { paymentId: id, reference, cards: settings.cards };
}
/**
 * Referral first-purchase hook (§36): a configured PERCENT of the payment as
 * POINTS for the referrer (round 17 hardcoded 10%), exactly-once per referral
 * via uq_referral_rewards. Honors the round-18 master referral toggle.
 * Must never break the payment path — every failure is swallowed and logged.
 */
async function referralHookFirstPurchase(tenantId, amountRial, tx) {
    // Best-effort settings read (plain read on system_settings — no locks the
    // surrounding payment transaction could conflict with). On any failure the
    // built-in defaults (enabled=true, 10%) keep the historical behavior.
    let referralEnabled = true;
    let percent = 10;
    try {
        const settings = await (0, system_settings_service_js_1.getReferralSettings)();
        referralEnabled = settings.enabled;
        percent = settings.firstPurchasePercent;
    }
    catch {
        // settings read failure must NOT fail the payment — fall back to defaults
    }
    if (!referralEnabled)
        return; // master toggle off → no reward at all
    try {
        if (tx) {
            await applyFirstPurchaseReward(tx, tenantId, amountRial, percent);
        }
        else {
            const db = (0, client_js_1.getDb)();
            await db.transaction((t) => applyFirstPurchaseReward(t, tenantId, amountRial, percent));
        }
    }
    catch (err) {
        // The referral reward is best-effort; it must never fail the payment.
        (0, audit_js_1.audit)({ action: 'referral.reward_failed', subjectType: 'user', subjectId: tenantId, meta: { reason: String(err.message).slice(0, 120) } }).catch(() => undefined);
    }
}
async function applyFirstPurchaseReward(tx, tenantId, amountRial, percent) {
    const [referral] = await tx
        .select()
        .from(schema_js_1.referrals)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.referrals.referredTenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.referrals.state, 'REGISTERED')))
        .limit(1);
    if (!referral)
        return;
    const points = Math.floor((amountRial * percent) / 100 / exports.POINT_TO_RIAL); // درصد پاداش خرید اول به امتیاز
    if (points <= 0)
        return;
    try {
        await tx.insert(schema_js_1.referralRewards).values({
            id: (0, ids_js_1.newId)(),
            referralId: referral.id,
            rewardKind: 'FIRST_PURCHASE',
            amount: points,
        });
    }
    catch (err) {
        const e = err;
        if (e?.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(String(e?.message ?? '')))
            return; // idempotent
        throw err;
    }
    await (0, wallet_service_js_1.pointCreditTx)(tx, referral.referrerTenantId, points, { type: 'referral_first_purchase', id: referral.id }, 'پاداش اولین خرید زیرمجموعه');
    await tx.update(schema_js_1.referrals).set({ state: 'REWARDED' }).where((0, drizzle_orm_1.eq)(schema_js_1.referrals.id, referral.id));
    await (0, events_js_1.emitEvent)({
        name: 'referral.rewarded',
        tenantId: referral.referrerTenantId,
        subjectType: 'referral',
        subjectId: referral.id,
        props: { rewardKind: 'FIRST_PURCHASE', points },
    });
    await (0, audit_js_1.audit)({
        action: 'referral.first_purchase_reward',
        actorId: tenantId,
        subjectType: 'referral',
        subjectId: referral.id,
        meta: { points },
    });
}
/**
 * Gateway callback (§117): real server-side verification via
 * gateway.verifyPayment — the browser-reported status is never trusted.
 * Wrapped in durable idempotency (scope payment_verify, 24h). All financial
 * side effects happen in the same transaction as the VERIFIED flip.
 */
class CallbackNotSettled extends Error {
    result;
    constructor(result) {
        super('PAYMENT_CALLBACK_NOT_SETTLED');
        this.result = result;
    }
}
async function handleCallback(q) {
    // Browser redirects are untrusted. They may trigger a gateway verification,
    // but a negative status must never itself mutate the payment or be cached as
    // a terminal result. Failed verification releases the idempotency key so a
    // later callback can be rechecked against the provider.
    try {
        const { replayed, value } = await (0, idempotency_js_1.runIdempotent)('payment_verify', q.paymentId, 86_400, async () => {
            const result = await verifyAndSettle(q);
            if (!result.ok)
                throw new CallbackNotSettled(result);
            return result;
        });
        if (replayed && value.ok) {
            return { ok: true, message: 'پرداخت شما پیش‌تر تأیید و اعمال شده است.' };
        }
        return value;
    }
    catch (err) {
        if (err instanceof CallbackNotSettled)
            return err.result;
        if (err instanceof Error && err.message === 'IDEMPOTENCY_IN_PROGRESS') {
            return { ok: false, message: 'پردازش این پرداخت در حال انجام است. نتیجه به‌زودی اعمال می‌شود.' };
        }
        if (err instanceof errors_js_1.AppError && err.code === 'NOT_FOUND') {
            return { ok: false, message: 'پرداخت مورد نظر یافت نشد.' };
        }
        return { ok: false, message: 'تأیید پرداخت ناموفق بود. اگر مبلغ کسر شده باشد به‌صورت خودکار بازگردانده می‌شود.' };
    }
}
async function verifyAndSettle(q) {
    const db = (0, client_js_1.getDb)();
    const [payment] = await db.select().from(schema_js_1.payments).where((0, drizzle_orm_1.eq)(schema_js_1.payments.id, q.paymentId)).limit(1);
    if (!payment)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پرداخت'));
    // Callback authenticity boundary: before any callback status can mutate
    // the payment, the gateway-returned transaction identifier must match the
    // authority that was stored when this payment was created. This is required
    // even for negative statuses; otherwise anyone who learns a paymentId could
    // forge `status=failed` / `Status=NOK` and cancel the payment without proof
    // that the gateway actually produced that callback.
    const reportedAuthority = (q.Authority ?? q.trackId ?? q.id)?.trim();
    if (!payment.authority || !reportedAuthority || reportedAuthority.toUpperCase() !== payment.authority.trim().toUpperCase()) {
        throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_VERIFY_FAILED());
    }
    // Already settled (browser refresh / duplicate redirect)
    if (payment.state === 'VERIFIED') {
        return { ok: true, message: 'پرداخت شما قبلاً تأیید شده است.' };
    }
    if (payment.state === 'CANCELLED' || payment.state === 'REFUNDED') {
        return { ok: false, message: 'این پرداخت قابل تأیید نیست.' };
    }
    // Gateway-reported status. WinaPay requires PaymentStatus=OK before Verify.
    // Zarinpal sends Status=OK|NOK; zibal/idpay send a gateway-specific `status`.
    // Negative/invalid reports fail immediately; other gateways retain their
    // existing server-side verification path (§117 — the browser is never trusted).
    const reported = (q.Status ?? q.status ?? '').trim().toLowerCase();
    // WinaPay explicitly requires PaymentStatus=OK before Verification.
    // Unknown/missing statuses must never be treated as authorization to settle.
    if (payment.gateway === 'winapay' && reported !== 'ok') {
        // A non-OK or missing browser-reported status is not terminal. Do not
        // mutate payment state; only a valid positive callback can reach the
        // gateway's server-side verification below.
        return { ok: false, message: 'وضعیت بازگشت از ویناپی معتبر نیست.' };
    }
    if (!payment.authority)
        throw new errors_js_1.AppError(errors_js_1.ERR.PAYMENT_VERIFY_FAILED());
    // Verify with the SAME provider that created this payment (payments.gateway
    // column), so admin provider switches never break in-flight verifications.
    const gw = await gatewayFor(payment.gateway);
    const verified = await gw.verifyPayment(Number(payment.amountRial), payment.authority);
    if (!verified.ok) {
        await db
            .update(schema_js_1.payments)
            .set({ state: 'FAILED', metaJson: { ...(payment.metaJson ?? {}), gatewayCode: verified.code } })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.payments.id, payment.id), (0, drizzle_orm_1.eq)(schema_js_1.payments.state, payment.state)));
        await (0, events_js_1.emitEvent)({ name: 'payment.failed', tenantId: payment.tenantId, subjectType: 'payment', subjectId: payment.id });
        return { ok: false, message: 'تأیید پرداخت نزد درگاه ناموفق بود. اگر مبلغ کسر شده باشد به‌صورت خودکار بازگردانده می‌شود.' };
    }
    let applied = false;
    const activationState = { value: null };
    await db.transaction(async (tx) => {
        const flipped = await tx
            .update(schema_js_1.payments)
            .set({ state: 'VERIFIED', verifiedAt: new Date(), gatewayRef: verified.refId ?? null })
            // FAILED can mean an earlier verification attempt was inconclusive.
            // Only an affirmative server-to-server result reaches this transition;
            // atomic state matching still guarantees that financial side effects run once.
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.payments.id, payment.id), (0, drizzle_orm_1.inArray)(schema_js_1.payments.state, ['CREATED', 'REDIRECTED', 'FAILED'])));
        const affected = Array.isArray(flipped) ? Number(flipped[0]?.affectedRows ?? 0) : Number(flipped.affectedRows ?? 0);
        if (affected !== 1)
            return;
        applied = true;
        if (payment.purpose === 'SUBSCRIPTION' && payment.planId) {
            activationState.value = await (0, plan_service_js_1.activateSubscriptionTx)(tx, payment.tenantId, payment.planId, payment.months);
            await referralHookFirstPurchase(payment.tenantId, Number(payment.amountRial), tx);
        }
        else if (payment.purpose === 'WALLET_TOPUP') {
            await (0, wallet_service_js_1.moveMoneyTx)(tx, payment.tenantId, 'CREDIT', Number(payment.amountRial), { type: 'payment', id: payment.id }, 'شارژ کیف پول');
        }
    });
    if (!applied) {
        if (payment.state === 'COMPLETED')
            return { ok: true, message: 'پرداخت شما قبلاً تأیید و اعمال شده است.' };
        return { ok: false, message: 'این پرداخت قبلاً پردازش شده یا دیگر قابل تأیید نیست.' };
    }
    const activated = activationState.value;
    await (0, events_js_1.emitEvent)({
        name: 'payment.completed',
        tenantId: payment.tenantId,
        subjectType: 'payment',
        subjectId: payment.id,
        props: { purpose: payment.purpose, amountRial: Number(payment.amountRial), refId: verified.refId },
    });
    if (activated) {
        await (0, events_js_1.emitEvent)({
            name: activated.renewed ? 'subscription.renewed' : 'subscription.created',
            tenantId: payment.tenantId,
            subjectType: 'subscription',
            subjectId: activated.subscriptionId,
            props: { planCode: activated.planCode, months: payment.months, renewed: activated.renewed, paymentId: payment.id },
        });
    }
    await (0, audit_js_1.audit)({
        action: 'payment.verified',
        actorId: payment.tenantId,
        subjectType: 'payment',
        subjectId: payment.id,
        meta: { purpose: payment.purpose, amountRial: Number(payment.amountRial), gateway: payment.gateway },
    });
    return {
        ok: true,
        message: payment.purpose === 'SUBSCRIPTION' ? 'پرداخت با موفقیت انجام و اشتراک شما فعال شد.' : 'پرداخت با موفقیت انجام و کیف پول شما شارژ شد.',
    };
}
async function listPayments(tenantId, page, pageSize) {
    const db = (0, client_js_1.getDb)();
    const p = Math.max(1, Math.floor(page));
    const size = Math.min(100, Math.max(1, Math.floor(pageSize)));
    const [totalRow] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.payments).where((0, drizzle_orm_1.eq)(schema_js_1.payments.tenantId, tenantId));
    const rows = await db
        .select({
        id: schema_js_1.payments.id,
        purpose: schema_js_1.payments.purpose,
        planId: schema_js_1.payments.planId,
        months: schema_js_1.payments.months,
        amountRial: schema_js_1.payments.amountRial,
        gateway: schema_js_1.payments.gateway,
        state: schema_js_1.payments.state,
        verifiedAt: schema_js_1.payments.verifiedAt,
        createdAt: schema_js_1.payments.createdAt,
    })
        .from(schema_js_1.payments)
        .where((0, drizzle_orm_1.eq)(schema_js_1.payments.tenantId, tenantId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.payments.createdAt))
        .limit(size)
        .offset((p - 1) * size);
    return {
        items: rows.map((r) => ({ ...r, amountRial: Number(r.amountRial) })),
        total: Number(totalRow?.value ?? 0),
        page: p,
        pageSize: size,
    };
}
