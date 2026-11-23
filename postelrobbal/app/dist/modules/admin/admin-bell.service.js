"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminBellSnapshot = getAdminBellSnapshot;
exports.markAdminBellSeen = markAdminBellSeen;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
function bellSeenKey(adminId) {
    return `admin_bell_seen:${adminId}`;
}
function isRecord(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** lastSeenAt from the seen-marker document; null when absent/unparsable. */
async function readBellSeenAt(adminId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({ valueJson: schema_js_1.systemSettings.valueJson })
        .from(schema_js_1.systemSettings)
        .where((0, drizzle_orm_1.eq)(schema_js_1.systemSettings.settingKey, bellSeenKey(adminId)))
        .limit(1);
    const raw = isRecord(row?.valueJson) ? row.valueJson['seenAt'] : undefined;
    if (typeof raw !== 'string' || raw.trim() === '')
        return null;
    const ts = Date.parse(raw);
    return Number.isNaN(ts) ? null : raw;
}
/** Maps a payments row (joined with its tenant user) to a bell ref. */
function paymentRef(row) {
    return {
        id: row.id,
        title: 'فیش واریزی',
        sub: row.email ?? '—',
        amountRial: Number(row.amountRial),
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    };
}
/** Maps a tickets row (joined with its tenant user) to a bell ref. */
function ticketRef(row) {
    return {
        id: row.id,
        title: row.subject,
        sub: row.email ?? '—',
        createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    };
}
const num = (v) => Number(v ?? 0);
async function getAdminBellSnapshot(adminId, includeManagementDetails = true) {
    const db = (0, client_js_1.getDb)();
    const lastSeenAt = await readBellSeenAt(adminId);
    const seenDate = lastSeenAt ? new Date(lastSeenAt) : new Date(0);
    const since7d = new Date(Date.now() - 7 * 86400_000);
    // One seen-marker read, plus count/latest queries for the categories the
    // caller is authorized to view. SUPPORT requests only ticket data; payment,
    // user and survey queries are skipped rather than queried and then redacted.
    const payAggRows = includeManagementDetails ? await db
        .select({
        total: (0, drizzle_orm_1.count)(),
        unread: (0, drizzle_orm_1.sql) `COALESCE(SUM(CASE WHEN ${schema_js_1.payments.createdAt} > ${seenDate} THEN 1 ELSE 0 END), 0)`,
    })
        .from(schema_js_1.payments)
        .where((0, drizzle_orm_1.eq)(schema_js_1.payments.state, 'PENDING_REVIEW')) : [];
    const payLatest = includeManagementDetails ? await db
        .select({
        id: schema_js_1.payments.id,
        amountRial: schema_js_1.payments.amountRial,
        createdAt: schema_js_1.payments.createdAt,
        email: schema_js_1.users.email,
    })
        .from(schema_js_1.payments)
        .leftJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.payments.tenantId))
        .where((0, drizzle_orm_1.eq)(schema_js_1.payments.state, 'PENDING_REVIEW'))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.payments.createdAt))
        .limit(5) : [];
    const ticketAggRows = await db
        .select({
        total: (0, drizzle_orm_1.count)(),
        unread: (0, drizzle_orm_1.sql) `COALESCE(SUM(CASE WHEN ${schema_js_1.tickets.createdAt} > ${seenDate} THEN 1 ELSE 0 END), 0)`,
    })
        .from(schema_js_1.tickets)
        .where((0, drizzle_orm_1.eq)(schema_js_1.tickets.state, 'OPEN'));
    const ticketLatest = await db
        .select({
        id: schema_js_1.tickets.id,
        subject: schema_js_1.tickets.subject,
        createdAt: schema_js_1.tickets.createdAt,
        email: schema_js_1.users.email,
    })
        .from(schema_js_1.tickets)
        .leftJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.tickets.tenantId))
        .where((0, drizzle_orm_1.eq)(schema_js_1.tickets.state, 'OPEN'))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.tickets.createdAt))
        .limit(5);
    const userAggRows = includeManagementDetails ? await db
        .select({
        total: (0, drizzle_orm_1.count)(),
        unread: (0, drizzle_orm_1.sql) `COALESCE(SUM(CASE WHEN ${schema_js_1.users.createdAt} > ${seenDate} THEN 1 ELSE 0 END), 0)`,
    })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.users.role, 'USER'), (0, drizzle_orm_1.sql) `${schema_js_1.users.createdAt} >= ${since7d}`)) : [];
    const userLatest = includeManagementDetails ? await db
        .select({
        id: schema_js_1.users.id,
        firstName: schema_js_1.users.firstName,
        lastName: schema_js_1.users.lastName,
        email: schema_js_1.users.email,
        createdAt: schema_js_1.users.createdAt,
    })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.users.role, 'USER'), (0, drizzle_orm_1.sql) `${schema_js_1.users.createdAt} >= ${since7d}`))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.users.createdAt))
        .limit(5) : [];
    const surveyAggRows = includeManagementDetails ? await db
        .select({
        total: (0, drizzle_orm_1.count)(),
        unread: (0, drizzle_orm_1.sql) `COALESCE(SUM(CASE WHEN ${schema_js_1.surveys.createdAt} > ${seenDate} THEN 1 ELSE 0 END), 0)`,
    })
        .from(schema_js_1.surveys)
        .where((0, drizzle_orm_1.eq)(schema_js_1.surveys.status, 'PENDING')) : [];
    const surveyLatest = includeManagementDetails ? await db
        .select({
        id: schema_js_1.surveys.id,
        question: schema_js_1.surveys.question,
        email: schema_js_1.users.email,
        firstName: schema_js_1.users.firstName,
        lastName: schema_js_1.users.lastName,
        createdAt: schema_js_1.surveys.createdAt,
    })
        .from(schema_js_1.surveys)
        .leftJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.surveys.creatorId))
        .where((0, drizzle_orm_1.eq)(schema_js_1.surveys.status, 'PENDING'))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.surveys.createdAt))
        .limit(5) : [];
    const toAgg = (rows) => ({
        total: num(rows[0]?.total),
        unread: num(rows[0]?.unread),
    });
    const pendingPayments = {
        count: toAgg(payAggRows).total,
        unread: toAgg(payAggRows).unread,
        latest: payLatest.map(paymentRef),
    };
    const openTickets = {
        count: toAgg(ticketAggRows).total,
        unread: toAgg(ticketAggRows).unread,
        latest: ticketLatest.map(ticketRef),
    };
    const newUsers = {
        count: toAgg(userAggRows).total,
        unread: toAgg(userAggRows).unread,
        latest: userLatest.map((r) => ({
            id: r.id,
            title: `${r.firstName} ${r.lastName}`.trim() || 'کاربر جدید',
            sub: r.email,
            createdAt: r.createdAt ? r.createdAt.toISOString() : null,
        })),
    };
    const pendingSurveys = {
        count: toAgg(surveyAggRows).total,
        unread: toAgg(surveyAggRows).unread,
        latest: surveyLatest.map((r) => ({
            id: r.id,
            title: r.question,
            sub: r.email ?? (`${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || 'ثبت‌کنندهٔ نظرسنجی'),
            createdAt: r.createdAt ? r.createdAt.toISOString() : null,
        })),
    };
    return {
        lastSeenAt,
        pendingPayments,
        pendingSurveys,
        openTickets,
        newUsers,
        unreadTotal: pendingPayments.unread + pendingSurveys.unread + openTickets.unread + newUsers.unread,
    };
}
/** Upserts the seen marker to «now»; returns the stored timestamp. */
async function markAdminBellSeen(adminId) {
    const db = (0, client_js_1.getDb)();
    const lastSeenAt = new Date().toISOString();
    await db
        .insert(schema_js_1.systemSettings)
        .values({ settingKey: bellSeenKey(adminId), valueJson: { seenAt: lastSeenAt } })
        .onDuplicateKeyUpdate({ set: { valueJson: { seenAt: lastSeenAt } } });
    return { lastSeenAt };
}
