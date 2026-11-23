"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.moveMoneyTx = moveMoneyTx;
exports.moveMoney = moveMoney;
exports.pointCreditTx = pointCreditTx;
exports.pointSpendTx = pointSpendTx;
exports.point_credit = point_credit;
exports.point_spend = point_spend;
exports.getPointsBalance = getPointsBalance;
exports.getWalletSummary = getWalletSummary;
exports.convertPoints = convertPoints;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const ids_js_1 = require("../../core/ids.js");
/** MySQL duplicate-entry detector (used for unique-ref idempotency). */
function isDuplicateError(err) {
    const e = err;
    return e?.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(String(e?.message ?? ''));
}
const CREDIT_KINDS = new Set(['CREDIT', 'REFUND', 'BONUS']);
/**
 * Money movement inside an existing transaction (§119). Row-level lock on the
 * wallet account serializes concurrent updates; balance_after is computed from
 * the locked row (never in PHP outside the lock). uq_ledger_ref(ref_type,
 * ref_id, entry_kind) makes referenced moves exactly-once — a duplicate is
 * treated as a successful replay.
 */
async function moveMoneyTx(tx, tenantId, entryKind, amountRial, ref, memoFa) {
    if (!Number.isInteger(amountRial) || amountRial === 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مبلغ تراکنش معتبر نیست.'));
    }
    const refType = ref.type ?? null;
    const refId = ref.id ?? null;
    if ((refType === null) !== (refId === null)) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مرجع تراکنش باید کامل باشد.'));
    }
    // The wallet account is the serialization row. The idempotency lookup must
    // happen AFTER this lock; otherwise two concurrent identical callbacks can
    // both pass the early lookup, update the balance twice, then have the second
    // ledger insert fail on the unique key while still committing its balance.
    await tx.execute((0, drizzle_orm_1.sql) `INSERT IGNORE INTO wallet_accounts (tenant_id, balance_rial) VALUES (${tenantId}, 0)`);
    // drizzle mysql2 tx.execute() returns the raw tuple [rows, fields]
    const lockedRaw = await tx.execute((0, drizzle_orm_1.sql) `SELECT balance_rial FROM wallet_accounts WHERE tenant_id = ${tenantId} FOR UPDATE`);
    const lockedRows = (Array.isArray(lockedRaw) ? lockedRaw[0] : lockedRaw.rows ?? []);
    const current = Number(lockedRows[0]?.balance_rial ?? 0);
    // Re-check the idempotency reference while holding the account lock. This is
    // intentionally before any balance mutation. The tenant is part of the
    // lookup even on legacy schemas whose unique index did not include it.
    if (refType && refId) {
        const [existing] = await tx
            .select({ id: schema_js_1.walletLedger.id, balanceAfter: schema_js_1.walletLedger.balanceAfter })
            .from(schema_js_1.walletLedger)
            .where((0, drizzle_orm_1.sql) `${schema_js_1.walletLedger.tenantId} = ${tenantId} AND ${schema_js_1.walletLedger.refType} = ${refType} AND ${schema_js_1.walletLedger.refId} = ${refId} AND ${schema_js_1.walletLedger.entryKind} = ${entryKind}`)
            .limit(1);
        if (existing)
            return { id: existing.id, balanceAfter: Number(existing.balanceAfter), replayed: true };
    }
    let delta;
    if (entryKind === 'ADJUSTMENT') {
        delta = amountRial; // signed
    }
    else if (CREDIT_KINDS.has(entryKind)) {
        delta = Math.abs(amountRial);
    }
    else {
        delta = -Math.abs(amountRial);
    }
    const newBalance = current + delta;
    if (newBalance < 0)
        throw new errors_js_1.AppError(errors_js_1.ERR.WALLET_INSUFFICIENT());
    await tx
        .update(schema_js_1.walletAccounts)
        .set({ balanceRial: newBalance })
        .where((0, drizzle_orm_1.eq)(schema_js_1.walletAccounts.tenantId, tenantId));
    const id = (0, ids_js_1.newId)();
    try {
        await tx.insert(schema_js_1.walletLedger).values({
            id,
            tenantId,
            entryKind,
            amountRial: entryKind === 'ADJUSTMENT' ? amountRial : Math.abs(amountRial),
            balanceAfter: newBalance,
            refType,
            refId,
            memoFa: memoFa.slice(0, 250),
        });
    }
    catch (err) {
        if (isDuplicateError(err) && refType && refId) {
            const [existing] = await tx
                .select({ id: schema_js_1.walletLedger.id, balanceAfter: schema_js_1.walletLedger.balanceAfter })
                .from(schema_js_1.walletLedger)
                .where((0, drizzle_orm_1.sql) `${schema_js_1.walletLedger.tenantId} = ${tenantId} AND ${schema_js_1.walletLedger.refType} = ${refType} AND ${schema_js_1.walletLedger.refId} = ${refId} AND ${schema_js_1.walletLedger.entryKind} = ${entryKind}`)
                .limit(1);
            if (existing)
                return { id: existing.id, balanceAfter: Number(existing.balanceAfter), replayed: true };
        }
        throw err;
    }
    return { id, balanceAfter: newBalance, replayed: false };
}
/** Public entry: own transaction. */
async function moveMoney(tenantId, entryKind, amountRial, ref, memoFa) {
    const db = (0, client_js_1.getDb)();
    return db.transaction((tx) => moveMoneyTx(tx, tenantId, entryKind, amountRial, ref, memoFa));
}
/**
 * Point balance is maintained via the last ledger row's balance_after. The
 * last row is read with FOR UPDATE inside the caller's transaction so
 * concurrent awards serialize instead of lost-updating.
 */
async function currentPointsTx(tx, tenantId) {
    // Use the wallet account singleton as the serialization row even before the
    // first point entry exists. Without this, two concurrent first awards both
    // observe balance=0 and write conflicting balance_after values.
    await tx.execute((0, drizzle_orm_1.sql) `INSERT IGNORE INTO wallet_accounts (tenant_id, balance_rial) VALUES (${tenantId}, 0)`);
    await tx.execute((0, drizzle_orm_1.sql) `SELECT tenant_id FROM wallet_accounts WHERE tenant_id = ${tenantId} FOR UPDATE`);
    const lockedRaw = await tx.execute((0, drizzle_orm_1.sql) `SELECT balance_after FROM point_ledger WHERE tenant_id = ${tenantId} ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`);
    const lockedRows = (Array.isArray(lockedRaw) ? lockedRaw[0] : lockedRaw.rows ?? []);
    return Number(lockedRows[0]?.balance_after ?? 0);
}
async function insertPointRow(tx, tenantId, entryKind, amount, balanceAfter, ref, memoFa) {
    const id = (0, ids_js_1.newId)();
    await tx.insert(schema_js_1.pointLedger).values({
        id,
        tenantId,
        entryKind,
        amount,
        balanceAfter,
        refType: ref.type ?? null,
        refId: ref.id ?? null,
        memoFa: memoFa.slice(0, 250),
    });
    return id;
}
async function pointCreditTx(tx, tenantId, points, ref, memoFa) {
    if (!Number.isInteger(points) || points <= 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('تعداد امتیاز معتبر نیست.'));
    }
    const current = await currentPointsTx(tx, tenantId);
    if (ref.type && ref.id) {
        const [existing] = await tx
            .select({ id: schema_js_1.pointLedger.id, balanceAfter: schema_js_1.pointLedger.balanceAfter })
            .from(schema_js_1.pointLedger)
            .where((0, drizzle_orm_1.sql) `${schema_js_1.pointLedger.tenantId} = ${tenantId} AND ${schema_js_1.pointLedger.refType} = ${ref.type} AND ${schema_js_1.pointLedger.refId} = ${ref.id} AND ${schema_js_1.pointLedger.entryKind} = 'EARN'`)
            .limit(1);
        if (existing)
            return { id: existing.id, balanceAfter: Number(existing.balanceAfter) };
    }
    const balanceAfter = current + points;
    const id = await insertPointRow(tx, tenantId, 'EARN', points, balanceAfter, ref, memoFa);
    return { id, balanceAfter };
}
async function pointSpendTx(tx, tenantId, points, ref, memoFa) {
    if (!Number.isInteger(points) || points <= 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('تعداد امتیاز معتبر نیست.'));
    }
    const current = await currentPointsTx(tx, tenantId);
    if (ref.type && ref.id) {
        const [existing] = await tx
            .select({ id: schema_js_1.pointLedger.id, balanceAfter: schema_js_1.pointLedger.balanceAfter })
            .from(schema_js_1.pointLedger)
            .where((0, drizzle_orm_1.sql) `${schema_js_1.pointLedger.tenantId} = ${tenantId} AND ${schema_js_1.pointLedger.refType} = ${ref.type} AND ${schema_js_1.pointLedger.refId} = ${ref.id} AND ${schema_js_1.pointLedger.entryKind} = 'SPEND'`)
            .limit(1);
        if (existing)
            return { id: existing.id, balanceAfter: Number(existing.balanceAfter) };
    }
    if (current < points) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('امتیاز کافی برای این کار ندارید.'));
    }
    const balanceAfter = current - points;
    const id = await insertPointRow(tx, tenantId, 'SPEND', points, balanceAfter, ref, memoFa);
    return { id, balanceAfter };
}
async function point_credit(tenantId, points, ref, memoFa) {
    const db = (0, client_js_1.getDb)();
    return db.transaction((tx) => pointCreditTx(tx, tenantId, points, ref, memoFa));
}
async function point_spend(tenantId, points, ref, memoFa) {
    const db = (0, client_js_1.getDb)();
    return db.transaction((tx) => pointSpendTx(tx, tenantId, points, ref, memoFa));
}
/** Points balance derived from ledger sum (single cheap aggregate). */
async function getPointsBalance(tenantId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({
        value: (0, drizzle_orm_1.sql) `COALESCE(SUM(CASE WHEN ${schema_js_1.pointLedger.entryKind} = 'SPEND' THEN -${schema_js_1.pointLedger.amount} ELSE ${schema_js_1.pointLedger.amount} END), 0)`,
    })
        .from(schema_js_1.pointLedger)
        .where((0, drizzle_orm_1.eq)(schema_js_1.pointLedger.tenantId, tenantId));
    return Number(row?.value ?? 0);
}
async function getWalletSummary(tenantId) {
    const db = (0, client_js_1.getDb)();
    const [account] = await db
        .select({ balanceRial: schema_js_1.walletAccounts.balanceRial })
        .from(schema_js_1.walletAccounts)
        .where((0, drizzle_orm_1.eq)(schema_js_1.walletAccounts.tenantId, tenantId))
        .limit(1);
    const rows = await db
        .select()
        .from(schema_js_1.walletLedger)
        .where((0, drizzle_orm_1.eq)(schema_js_1.walletLedger.tenantId, tenantId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.walletLedger.createdAt), (0, drizzle_orm_1.desc)(schema_js_1.walletLedger.id))
        .limit(20);
    return {
        balanceRial: Number(account?.balanceRial ?? 0),
        pointsBalance: await getPointsBalance(tenantId),
        ledger: rows.map((r) => ({
            id: r.id,
            entryKind: r.entryKind,
            amountRial: Number(r.amountRial),
            balanceAfter: Number(r.balanceAfter),
            refType: r.refType,
            refId: r.refId,
            memoFa: r.memoFa,
            createdAt: r.createdAt,
        })),
    };
}
/** Points → wallet balance (min 100 points, ۱۰ ریال per point). */
async function convertPoints(tenantId, points) {
    if (!Number.isInteger(points) || points < 100) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('حداقل امتیاز قابل تبدیل ۱۰۰ امتیاز است.'));
    }
    const amountRial = points * 10;
    const db = (0, client_js_1.getDb)();
    const result = await db.transaction(async (tx) => {
        const ref = { type: 'points_convert', id: (0, ids_js_1.newId)() };
        await pointSpendTx(tx, tenantId, points, ref, 'تبدیل امتیاز به موجودی');
        const moved = await moveMoneyTx(tx, tenantId, 'CREDIT', amountRial, ref, 'تبدیل امتیاز به موجودی');
        return moved.balanceAfter;
    });
    const pointsRemaining = await getPointsBalance(tenantId);
    return { amountRial, balanceRial: result, pointsRemaining };
}
