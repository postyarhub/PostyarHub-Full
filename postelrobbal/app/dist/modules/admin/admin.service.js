"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOverview = getOverview;
exports.getUserProfile360 = getUserProfile360;
exports.listUsers = listUsers;
exports.listChannels = listChannels;
exports.listBots = listBots;
exports.setUserSuspended = setUserSuspended;
exports.grantSubscription = grantSubscription;
exports.getPaymentState = getPaymentState;
exports.listAdminPayments = listAdminPayments;
exports.approvePayment = approvePayment;
exports.rejectPayment = rejectPayment;
exports.listAuditLogs = listAuditLogs;
exports.deleteAuditLog = deleteAuditLog;
exports.deleteAuditLogsBulk = deleteAuditLogsBulk;
exports.listPlans = listPlans;
exports.createPlan = createPlan;
exports.deletePlan = deletePlan;
exports.updatePlan = updatePlan;
exports.getSettings = getSettings;
exports.putSettings = putSettings;
exports.broadcast = broadcast;
exports.getBroadcastTargets = getBroadcastTargets;
exports.releaseChannel = releaseChannel;
const drizzle_orm_1 = require("drizzle-orm");
const mysql_core_1 = require("drizzle-orm/mysql-core");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const ids_js_1 = require("../../core/ids.js");
const delivery_js_1 = require("../notifications/delivery.js");
const plan_service_js_1 = require("../subscriptions/plan.service.js");
const wallet_service_js_1 = require("../wallet/wallet.service.js");
const sessions_js_1 = require("../../security/sessions.js");
const payment_service_js_1 = require("../payments/payment.service.js");
const payment_settings_service_js_1 = require("../payments/payment-settings.service.js");
const num = (v) => Number(v ?? 0);
/** Runs thunks with bounded concurrency (pool: connectionLimit=DB_POOL_MAX=5,
 *  queueLimit=20 — an unbounded Promise.all of 27 queries overflows the queue
 *  and mysql2 aborts with "Queue limit reached"). */
async function mapLimit(tasks, limit) {
    const results = new Array(tasks.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (cursor < tasks.length) {
            const i = cursor++;
            const task = tasks[i];
            if (task === undefined)
                break;
            results[i] = await task();
        }
    });
    await Promise.all(workers);
    return results;
}
/**
 * Dashboard overview (admin-panel v2 nested shape).
 * Semantics verified against the real schema enums:
 *  - channels/bots: status 'ACTIVE' = connected; platform counts cover all rows.
 *  - post_targets states: PENDING|PROCESSING|SENT|RETRYING|FAILED|CANCELLED —
 *    successful deliveries are state 'SENT' (there is no PUBLISHED target state).
 *  - tickets states: OPEN|ANSWERED|CLOSED — open = state != CLOSED.
 */
async function getOverview() {
    const db = (0, client_js_1.getDb)();
    const since30d = new Date(Date.now() - 30 * 86400_000);
    const since24h = new Date(Date.now() - 24 * 3600_000);
    const results = await mapLimit([
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.users),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.status, 'ACTIVE')),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.status, 'SUSPENDED')),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.users).where((0, drizzle_orm_1.gte)(schema_js_1.users.createdAt, since30d)),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.channels),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.channels).where((0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE')),
        () => db.select({ platform: schema_js_1.channels.platform, value: (0, drizzle_orm_1.count)() }).from(schema_js_1.channels).groupBy(schema_js_1.channels.platform),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.bots),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.bots).where((0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE')),
        () => db.select({ platform: schema_js_1.bots.platform, value: (0, drizzle_orm_1.count)() }).from(schema_js_1.bots).groupBy(schema_js_1.bots.platform),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.goldConfigs),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.goldConfigs).where((0, drizzle_orm_1.eq)(schema_js_1.goldConfigs.isEnabled, 1)),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.goldSnapshots).where((0, drizzle_orm_1.gte)(schema_js_1.goldSnapshots.capturedAt, since24h)),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.posts),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.posts).where((0, drizzle_orm_1.eq)(schema_js_1.posts.state, 'SCHEDULED')),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.posts).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.state, 'PUBLISHED'), (0, drizzle_orm_1.gte)(schema_js_1.posts.publishedAt, since30d))),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.postTargets).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'FAILED'), (0, drizzle_orm_1.gte)(schema_js_1.postTargets.updatedAt, since24h))),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.postTargets).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.postTargets.state, 'SENT'), (0, drizzle_orm_1.gte)(schema_js_1.postTargets.updatedAt, since24h))),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.payments).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.payments.state, 'VERIFIED'), (0, drizzle_orm_1.gte)(schema_js_1.payments.verifiedAt, since30d))),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.payments).where((0, drizzle_orm_1.eq)(schema_js_1.payments.state, 'PENDING_REVIEW')),
        () => db.select({ sum: (0, drizzle_orm_1.sql) `COALESCE(SUM(${schema_js_1.payments.amountRial}), 0)` }).from(schema_js_1.payments).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.payments.state, 'VERIFIED'), (0, drizzle_orm_1.gte)(schema_js_1.payments.verifiedAt, since30d))),
        () => db.select({ sum: (0, drizzle_orm_1.sql) `COALESCE(SUM(${schema_js_1.payments.amountRial}), 0)` }).from(schema_js_1.payments).where((0, drizzle_orm_1.eq)(schema_js_1.payments.state, 'VERIFIED')),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.subscriptions).where((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.state, 'ACTIVE')),
        () => db
            .select({ planName: schema_js_1.plans.nameFa, value: (0, drizzle_orm_1.count)() })
            .from(schema_js_1.subscriptions)
            .innerJoin(schema_js_1.plans, (0, drizzle_orm_1.eq)(schema_js_1.plans.id, schema_js_1.subscriptions.planId))
            .where((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.state, 'ACTIVE'))
            .groupBy(schema_js_1.plans.nameFa),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.aiJobs).where((0, drizzle_orm_1.gte)(schema_js_1.aiJobs.createdAt, since30d)),
        () => db.select({ value: (0, drizzle_orm_1.count)(), bytes: (0, drizzle_orm_1.sql) `COALESCE(SUM(${schema_js_1.media.sizeBytes}), 0)` }).from(schema_js_1.media),
        () => db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.tickets).where((0, drizzle_orm_1.ne)(schema_js_1.tickets.state, 'CLOSED')),
    ], 5);
    const channelPlatformStateRows = await db.select({ platform: schema_js_1.channels.platform, status: schema_js_1.channels.status, value: (0, drizzle_orm_1.count)() }).from(schema_js_1.channels).groupBy(schema_js_1.channels.platform, schema_js_1.channels.status);
    const botPlatformStateRows = await db.select({ platform: schema_js_1.bots.platform, status: schema_js_1.bots.status, value: (0, drizzle_orm_1.count)() }).from(schema_js_1.bots).groupBy(schema_js_1.bots.platform, schema_js_1.bots.status);
    const [userTotal, userActive, userSuspended, userNew30d, channelTotal, channelActive, channelPlatforms, botTotal, botActive, botPlatforms, goldConfigRows, goldEnabled, goldSnap24h, postTotal, postScheduled, postPublished30d, targetFailed24h, targetSent24h, payVerified30d, payPendingReview, paySum30d, paySumTotal, subsActive, subsByPlan, aiJobs30d, mediaRows, ticketOpen,] = results;
    const platformCounts = (rows) => {
        const out = { telegram: 0, bale: 0, rubika: 0 };
        for (const r of rows) {
            if (r.platform === 'telegram' || r.platform === 'bale' || r.platform === 'rubika')
                out[r.platform] = num(r.value);
        }
        return out;
    };
    const platformState = (rows) => {
        const out = {
            telegram: { total: 0, active: 0, inactive: 0 },
            bale: { total: 0, active: 0, inactive: 0 },
            rubika: { total: 0, active: 0, inactive: 0 },
        };
        for (const row of rows) {
            if (!(row.platform in out))
                continue;
            const item = out[row.platform];
            item.total += num(row.value);
            if (row.status === 'ACTIVE')
                item.active += num(row.value);
            else
                item.inactive += num(row.value);
        }
        return out;
    };
    const channelByPlatform = platformState(channelPlatformStateRows.map(r => ({ platform: r.platform, status: r.status, value: Number(r.value) })));
    const botByPlatform = platformState(botPlatformStateRows.map(r => ({ platform: r.platform, status: r.status, value: Number(r.value) })));
    return {
        users: {
            total: num(userTotal[0]?.value),
            active: num(userActive[0]?.value),
            suspended: num(userSuspended[0]?.value),
            new30d: num(userNew30d[0]?.value),
        },
        channels: {
            total: num(channelTotal[0]?.value),
            active: num(channelActive[0]?.value),
            ...platformCounts(channelPlatforms.map((r) => ({ platform: r.platform, value: Number(r.value) }))),
            byPlatform: channelByPlatform,
        },
        bots: {
            total: num(botTotal[0]?.value),
            active: num(botActive[0]?.value),
            ...platformCounts(botPlatforms.map((r) => ({ platform: r.platform, value: Number(r.value) }))),
            byPlatform: botByPlatform,
        },
        gold: {
            configs: num(goldConfigRows[0]?.value),
            enabled: num(goldEnabled[0]?.value),
            snapshots24h: num(goldSnap24h[0]?.value),
        },
        posts: {
            total: num(postTotal[0]?.value),
            scheduled: num(postScheduled[0]?.value),
            published30d: num(postPublished30d[0]?.value),
            failed24h: num(targetFailed24h[0]?.value),
        },
        payments: {
            verifiedCount30d: num(payVerified30d[0]?.value),
            verifiedSum30d: num(paySum30d[0]?.sum),
            verifiedSumTotal: num(paySumTotal[0]?.sum),
            pendingReview: num(payPendingReview[0]?.value),
        },
        subscriptions: {
            active: num(subsActive[0]?.value),
            byPlan: subsByPlan.map((r) => ({ planName: r.planName, count: num(r.value) })),
        },
        usage: {
            aiJobs30d: num(aiJobs30d[0]?.value),
            mediaCount: num(mediaRows[0]?.value),
            mediaBytes: num(mediaRows[0]?.bytes),
            ticketsOpen: num(ticketOpen[0]?.value),
            deliveries24h: num(targetSent24h[0]?.value),
            deliveriesFailed24h: num(targetFailed24h[0]?.value),
        },
    };
}
// ---------------------------------------------------------------------------
// Round 18 — «پروفایل ۳۶۰ درجه» (asovin user-profile-modal parity, extended)
// ---------------------------------------------------------------------------
const ULIDISH = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
/**
 * 360° profile for one user: identity + active (or most recent) subscription
 * + bounded-concurrency stats. Missing/malformed ids are an indistinguishable
 * 404 (§180 no existence leak).
 */
async function getUserProfile360(userId) {
    if (!ULIDISH.test(userId))
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کاربر'));
    const db = (0, client_js_1.getDb)();
    const [user] = await db
        .select({
        id: schema_js_1.users.id,
        firstName: schema_js_1.users.firstName,
        lastName: schema_js_1.users.lastName,
        email: schema_js_1.users.email,
        mobile: schema_js_1.users.mobile,
        businessName: schema_js_1.users.businessName,
        businessType: schema_js_1.users.businessType,
        role: schema_js_1.users.role,
        status: schema_js_1.users.status,
        createdAt: schema_js_1.users.createdAt,
        lastLoginAt: schema_js_1.users.lastLoginAt,
        avatarKind: schema_js_1.users.avatarKind,
        avatarValue: schema_js_1.users.avatarValue,
        avatarMediaId: schema_js_1.users.avatarMediaId,
        referralCode: schema_js_1.users.referralCode,
    })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId))
        .limit(1);
    if (!user)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کاربر'));
    // Preferred: ACTIVE subscription (newest expiry); fallback: most recent row
    // of any state so admins always see the last known plan.
    const subRows = await db
        .select({
        planNameFa: schema_js_1.plans.nameFa,
        planCode: schema_js_1.plans.code,
        state: schema_js_1.subscriptions.state,
        startedAt: schema_js_1.subscriptions.startedAt,
        expiresAt: schema_js_1.subscriptions.expiresAt,
    })
        .from(schema_js_1.subscriptions)
        .innerJoin(schema_js_1.plans, (0, drizzle_orm_1.eq)(schema_js_1.plans.id, schema_js_1.subscriptions.planId))
        .where((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.tenantId, userId))
        .orderBy(
    // ACTIVE first, then newest expiry / most recently touched row.
    (0, drizzle_orm_1.sql) `CASE WHEN ${schema_js_1.subscriptions.state} = 'ACTIVE' THEN 0 ELSE 1 END`, (0, drizzle_orm_1.desc)(schema_js_1.subscriptions.expiresAt), (0, drizzle_orm_1.desc)(schema_js_1.subscriptions.updatedAt))
        .limit(1);
    const subscription = subRows[0] ?? null;
    const statResults = await mapLimit([
        () => db
            .select({
            total: (0, drizzle_orm_1.count)(),
            active: (0, drizzle_orm_1.sql) `COALESCE(SUM(CASE WHEN ${schema_js_1.channels.status} = 'ACTIVE' THEN 1 ELSE 0 END), 0)`,
        })
            .from(schema_js_1.channels)
            .where((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, userId)),
        () => db
            .select({
            total: (0, drizzle_orm_1.count)(),
            active: (0, drizzle_orm_1.sql) `COALESCE(SUM(CASE WHEN ${schema_js_1.bots.status} = 'ACTIVE' THEN 1 ELSE 0 END), 0)`,
        })
            .from(schema_js_1.bots)
            .where((0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, userId)),
        () => db
            .select({
            total: (0, drizzle_orm_1.count)(),
            active: (0, drizzle_orm_1.sql) `COALESCE(SUM(CASE WHEN ${schema_js_1.posts.state} = 'PUBLISHED' THEN 1 ELSE 0 END), 0)`,
        })
            .from(schema_js_1.posts)
            .where((0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, userId)),
        () => db
            .select({
            total: (0, drizzle_orm_1.count)(),
            active: (0, drizzle_orm_1.sql) `COALESCE(SUM(CASE WHEN ${schema_js_1.tickets.state} = 'OPEN' THEN 1 ELSE 0 END), 0)`,
        })
            .from(schema_js_1.tickets)
            .where((0, drizzle_orm_1.eq)(schema_js_1.tickets.tenantId, userId)),
        () => db
            .select({
            total: (0, drizzle_orm_1.count)(),
            sum: (0, drizzle_orm_1.sql) `COALESCE(SUM(${schema_js_1.payments.amountRial}), 0)`,
        })
            .from(schema_js_1.payments)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.payments.tenantId, userId), (0, drizzle_orm_1.inArray)(schema_js_1.payments.state, ['VERIFIED', 'COMPLETED']))),
        () => db.select({ balance: schema_js_1.walletAccounts.balanceRial }).from(schema_js_1.walletAccounts).where((0, drizzle_orm_1.eq)(schema_js_1.walletAccounts.tenantId, userId)).limit(1),
    ], 5);
    const [channelRows, botRows, postRows, ticketRows, payRows, walletRows] = statResults;
    return {
        user,
        subscription: subscription
            ? {
                planNameFa: subscription.planNameFa,
                planCode: subscription.planCode,
                state: subscription.state,
                startedAt: subscription.startedAt,
                expiresAt: subscription.expiresAt,
            }
            : null,
        stats: {
            channels: { total: num(channelRows[0]?.total), active: num(channelRows[0]?.active) },
            bots: { total: num(botRows[0]?.total), active: num(botRows[0]?.active) },
            posts: { total: num(postRows[0]?.total), published: num(postRows[0]?.active) },
            tickets: { total: num(ticketRows[0]?.total), open: num(ticketRows[0]?.active) },
            payments: {
                verifiedCount: num(payRows[0]?.total),
                verifiedSumRial: num(payRows[0]?.sum),
            },
            walletBalanceRial: num(walletRows[0]?.balance),
        },
    };
}
async function listUsers(search, page, pageSize) {
    const db = (0, client_js_1.getDb)();
    const p = Math.max(1, page);
    const size = Math.min(100, Math.max(1, pageSize));
    const term = search?.trim();
    const like = term ? `%${term.replace(/[%_]/g, '')}%` : null;
    const where = like
        ? (0, drizzle_orm_1.or)((0, drizzle_orm_1.sql) `${schema_js_1.users.email} LIKE ${like}`, (0, drizzle_orm_1.sql) `${schema_js_1.users.mobile} LIKE ${like}`, (0, drizzle_orm_1.sql) `${schema_js_1.users.businessName} LIKE ${like}`, (0, drizzle_orm_1.sql) `${schema_js_1.users.firstName} LIKE ${like}`, (0, drizzle_orm_1.sql) `${schema_js_1.users.lastName} LIKE ${like}`)
        : undefined;
    const [totalRow] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.users).where(where);
    const rows = await db
        .select({
        id: schema_js_1.users.id,
        firstName: schema_js_1.users.firstName,
        lastName: schema_js_1.users.lastName,
        email: schema_js_1.users.email,
        mobile: schema_js_1.users.mobile,
        businessName: schema_js_1.users.businessName,
        role: schema_js_1.users.role,
        status: schema_js_1.users.status,
        // Round 17: lets the admin table render standard character avatars.
        avatarKind: schema_js_1.users.avatarKind,
        avatarValue: schema_js_1.users.avatarValue,
        createdAt: schema_js_1.users.createdAt,
    })
        .from(schema_js_1.users)
        .where(where)
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.users.createdAt))
        .limit(size)
        .offset((p - 1) * size);
    return { items: rows, total: Number(totalRow?.value ?? 0), page: p, pageSize: size };
}
async function listChannels(search, platform, page, pageSize) {
    const db = (0, client_js_1.getDb)();
    const p = Math.max(1, page);
    const size = Math.min(100, Math.max(1, pageSize));
    const term = search?.trim();
    const like = term ? `%${term.replace(/[%_]/g, '')}%` : null;
    const where = (0, drizzle_orm_1.and)(platform ? (0, drizzle_orm_1.eq)(schema_js_1.channels.platform, platform) : undefined, like
        ? (0, drizzle_orm_1.or)((0, drizzle_orm_1.sql) `${schema_js_1.channels.title} LIKE ${like}`, (0, drizzle_orm_1.sql) `${schema_js_1.channels.channelRef} LIKE ${like}`, (0, drizzle_orm_1.sql) `${schema_js_1.users.email} LIKE ${like}`)
        : undefined);
    const ownerName = (0, drizzle_orm_1.sql) `COALESCE(CONCAT_WS(' ', ${schema_js_1.users.firstName}, ${schema_js_1.users.lastName}), '')`;
    const [totalRow] = await db
        .select({ value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.channels)
        .leftJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.channels.tenantId))
        .where(where);
    const rows = await db
        .select({
        id: schema_js_1.channels.id,
        platform: schema_js_1.channels.platform,
        channelRef: schema_js_1.channels.channelRef,
        title: schema_js_1.channels.title,
        status: schema_js_1.channels.status,
        createdAt: schema_js_1.channels.createdAt,
        ownerEmail: schema_js_1.users.email,
        ownerName,
    })
        .from(schema_js_1.channels)
        .leftJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.channels.tenantId))
        .where(where)
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.channels.createdAt))
        .limit(size)
        .offset((p - 1) * size);
    return { items: rows, total: Number(totalRow?.value ?? 0), page: p, pageSize: size };
}
async function listBots(search, platform, page, pageSize) {
    const db = (0, client_js_1.getDb)();
    const p = Math.max(1, page);
    const size = Math.min(100, Math.max(1, pageSize));
    const term = search?.trim();
    const like = term ? `%${term.replace(/[%_]/g, '')}%` : null;
    const where = (0, drizzle_orm_1.and)(platform ? (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, platform) : undefined, like
        ? (0, drizzle_orm_1.or)((0, drizzle_orm_1.sql) `${schema_js_1.bots.title} LIKE ${like}`, (0, drizzle_orm_1.sql) `${schema_js_1.bots.username} LIKE ${like}`, (0, drizzle_orm_1.sql) `${schema_js_1.users.email} LIKE ${like}`)
        : undefined);
    const [totalRow] = await db
        .select({ value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.bots)
        .leftJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.bots.tenantId))
        .where(where);
    // NOTE: tokens (token_encrypted/token_masked) are never selected here.
    const rows = await db
        .select({
        id: schema_js_1.bots.id,
        platform: schema_js_1.bots.platform,
        username: schema_js_1.bots.username,
        title: schema_js_1.bots.title,
        status: schema_js_1.bots.status,
        mode: schema_js_1.bots.mode,
        aiEnabled: schema_js_1.bots.aiEnabled,
        createdAt: schema_js_1.bots.createdAt,
        ownerEmail: schema_js_1.users.email,
    })
        .from(schema_js_1.bots)
        .leftJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.bots.tenantId))
        .where(where)
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.bots.createdAt))
        .limit(size)
        .offset((p - 1) * size);
    return {
        items: rows.map((r) => ({ ...r, aiEnabled: Number(r.aiEnabled) === 1 })),
        total: Number(totalRow?.value ?? 0),
        page: p,
        pageSize: size,
    };
}
async function assertAdminTargetMutable(targetId, operationFa) {
    const db = (0, client_js_1.getDb)();
    const [target] = await db.select({ id: schema_js_1.users.id, role: schema_js_1.users.role }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, targetId)).limit(1);
    if (!target)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کاربر'));
    if (target.role !== 'USER') {
        const label = target.role === 'SUPER_ADMIN' ? 'مدیر ارشد' : 'حساب مدیریتی';
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT(`${operationFa} برای ${label} مجاز نیست.`));
    }
}
async function setUserSuspended(actorId, targetId, suspended) {
    if (actorId === targetId) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('نمی‌توانید حساب خودتان را تغییر وضعیت دهید.'));
    }
    const db = (0, client_js_1.getDb)();
    await assertAdminTargetMutable(targetId, 'تغییر وضعیت حساب');
    await db.update(schema_js_1.users).set({ status: suspended ? 'SUSPENDED' : 'ACTIVE' }).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, targetId));
    if (suspended)
        await (0, sessions_js_1.revokeAllUserSessions)(targetId);
}
async function grantSubscription(tenantId, planCode, months) {
    const db = (0, client_js_1.getDb)();
    await assertAdminTargetMutable(tenantId, 'ویرایش حساب');
    const [plan] = await db.select().from(schema_js_1.plans).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.plans.code, planCode), (0, drizzle_orm_1.eq)(schema_js_1.plans.isActive, 1))).limit(1);
    if (!plan)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پلن'));
    const result = await (0, plan_service_js_1.activateSubscription)(tenantId, plan.id, months);
    return { subscriptionId: result.subscriptionId };
}
const PAYMENT_STATES = [
    'CREATED', 'REDIRECTED', 'VERIFIED', 'FAILED', 'CANCELLED', 'REFUNDED',
    'PENDING_REVIEW', 'REJECTED', 'COMPLETED',
];
/** Current state of a payment (for audit meta); null when missing. */
async function getPaymentState(paymentId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db.select({ state: schema_js_1.payments.state }).from(schema_js_1.payments).where((0, drizzle_orm_1.eq)(schema_js_1.payments.id, paymentId)).limit(1);
    return row?.state ?? null;
}
/** Alias for the reviewer join (a user row may appear as payer AND reviewer). */
const reviewer = (0, mysql_core_1.alias)(schema_js_1.users, 'reviewer');
async function listAdminPayments(state, page, pageSize) {
    const db = (0, client_js_1.getDb)();
    const p = Math.max(1, page);
    const size = Math.min(100, Math.max(1, pageSize));
    const where = state && PAYMENT_STATES.includes(state)
        ? (0, drizzle_orm_1.eq)(schema_js_1.payments.state, state)
        : undefined;
    const [totalRow] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.payments).where(where);
    const rows = await db
        .select({
        id: schema_js_1.payments.id,
        tenantId: schema_js_1.payments.tenantId,
        purpose: schema_js_1.payments.purpose,
        planId: schema_js_1.payments.planId,
        months: schema_js_1.payments.months,
        amountRial: schema_js_1.payments.amountRial,
        gateway: schema_js_1.payments.gateway,
        gatewayRef: schema_js_1.payments.gatewayRef,
        reference: schema_js_1.payments.reference,
        state: schema_js_1.payments.state,
        verifiedAt: schema_js_1.payments.verifiedAt,
        metaJson: schema_js_1.payments.metaJson,
        receiptMediaId: schema_js_1.payments.receiptMediaId,
        receiptNote: schema_js_1.payments.receiptNote,
        reviewedBy: schema_js_1.payments.reviewedBy,
        reviewedAt: schema_js_1.payments.reviewedAt,
        createdAt: schema_js_1.payments.createdAt,
        // user (payer) summary
        userFirstName: schema_js_1.users.firstName,
        userLastName: schema_js_1.users.lastName,
        userEmail: schema_js_1.users.email,
        userMobile: schema_js_1.users.mobile,
        // plan summary
        planCode: schema_js_1.plans.code,
        planNameFa: schema_js_1.plans.nameFa,
        // reviewer summary (round 19 payment popup)
        reviewedByName: (0, drizzle_orm_1.sql) `NULLIF(CONCAT(${reviewer.firstName}, ' ', ${reviewer.lastName}), ' ')`,
    })
        .from(schema_js_1.payments)
        .leftJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.payments.tenantId))
        .leftJoin(reviewer, (0, drizzle_orm_1.eq)(reviewer.id, schema_js_1.payments.reviewedBy))
        .leftJoin(schema_js_1.plans, (0, drizzle_orm_1.eq)(schema_js_1.plans.id, schema_js_1.payments.planId))
        .where(where)
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
/**
 * Admin review of payments (contract 14-contract item 5).
 *
 * Two flavours share one settlement service:
 *  - PENDING_REVIEW (card-to-card receipt) → state COMPLETED + reviewed_by/at.
 *  - Online fallback (§117 manual verify: CREATED/REDIRECTED/FAILED) → state
 *    VERIFIED, exactly like before.
 *
 * Idempotency: approving an already-settled payment (VERIFIED/COMPLETED) is a
 * NO-OP SUCCESS (chosen over 409 so a double-click or retry never errors).
 * All financial side effects (subscription activation / wallet credit /
 * referral first-purchase hook) run in ONE transaction, mirroring the online
 * verify path.
 */
async function approvePayment(actorId, paymentId, note) {
    const db = (0, client_js_1.getDb)();
    const [payment] = await db.select().from(schema_js_1.payments).where((0, drizzle_orm_1.eq)(schema_js_1.payments.id, paymentId)).limit(1);
    if (!payment)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پرداخت'));
    if (payment.state === 'VERIFIED' || payment.state === 'COMPLETED') {
        return { ok: true, message: 'این پرداخت پیش‌تر تأیید شده است.' };
    }
    if (payment.state === 'REJECTED' || payment.state === 'REFUNDED' || payment.state === 'CANCELLED') {
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('این پرداخت قابل تأیید نیست.'));
    }
    const now = new Date();
    await db.transaction(async (tx) => {
        // Re-read under lock: concurrent approvals must not double-settle.
        const [locked] = await tx.select().from(schema_js_1.payments).where((0, drizzle_orm_1.eq)(schema_js_1.payments.id, payment.id)).limit(1).for('update');
        if (!locked)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پرداخت'));
        if (locked.state === 'VERIFIED' || locked.state === 'COMPLETED')
            return; // settled concurrently → no-op
        if (locked.state === 'REJECTED' || locked.state === 'REFUNDED' || locked.state === 'CANCELLED') {
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('این پرداخت قابل تأیید نیست.'));
        }
        const lockedTarget = locked.state === 'PENDING_REVIEW' ? 'COMPLETED' : 'VERIFIED';
        const metaJson = { ...(locked.metaJson ?? {}) };
        if (note && note.trim() !== '')
            metaJson.reviewNote = note.trim().slice(0, 500);
        await tx
            .update(schema_js_1.payments)
            .set({
            state: lockedTarget,
            verifiedAt: now,
            reviewedBy: actorId,
            reviewedAt: now,
            metaJson,
        })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.payments.id, locked.id), (0, drizzle_orm_1.eq)(schema_js_1.payments.state, locked.state)));
        if (locked.purpose === 'SUBSCRIPTION' && locked.planId) {
            await (0, plan_service_js_1.activateSubscriptionTx)(tx, locked.tenantId, locked.planId, locked.months);
            await (0, payment_service_js_1.referralHookFirstPurchase)(locked.tenantId, Number(locked.amountRial), tx);
        }
        else if (locked.purpose === 'WALLET_TOPUP') {
            await (0, wallet_service_js_1.moveMoneyTx)(tx, locked.tenantId, 'CREDIT', Number(locked.amountRial), { type: 'payment', id: locked.id }, 'شارژ کیف پول (تأیید دستی)');
        }
    });
    await emitPaymentCompleted(payment, actorId);
    return { ok: true, message: 'پرداخت با موفقیت تأیید و اعمال شد.' };
}
async function emitPaymentCompleted(payment, actorId) {
    await (0, delivery_js_1.notifyTenant)({
        tenantId: payment.tenantId,
        kind: 'PAYMENT_APPROVED',
        titleFa: 'پرداخت شما تأیید شد',
        bodyFa: payment.purpose === 'SUBSCRIPTION'
            ? 'رسید پرداخت شما تأیید شد و اشتراک شما فعال/تمدید گردید.'
            : 'پرداخت شما تأیید و کیف پول شما شارژ شد.',
    }).catch(() => undefined);
    void actorId;
}
/**
 * Rejects a PENDING_REVIEW card-to-card payment. Idempotent: rejecting an
 * already-REJECTED payment is a no-op success; other non-reviewable states
 * raise a stable CONFLICT.
 */
async function rejectPayment(actorId, paymentId, reason) {
    const db = (0, client_js_1.getDb)();
    const [payment] = await db.select().from(schema_js_1.payments).where((0, drizzle_orm_1.eq)(schema_js_1.payments.id, paymentId)).limit(1);
    if (!payment)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پرداخت'));
    if (payment.state === 'REJECTED') {
        return { ok: true, message: 'این پرداخت پیش‌تر رد شده است.' };
    }
    if (payment.state !== 'PENDING_REVIEW') {
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('فقط پرداخت‌های در انتظار بررسی قابل رد هستند.'));
    }
    const metaJson = { ...(payment.metaJson ?? {}), rejectReason: reason.trim().slice(0, 500) };
    const now = new Date();
    const res = await db
        .update(schema_js_1.payments)
        .set({ state: 'REJECTED', reviewedBy: actorId, reviewedAt: now, metaJson })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.payments.id, payment.id), (0, drizzle_orm_1.eq)(schema_js_1.payments.state, 'PENDING_REVIEW')));
    const changed = Array.isArray(res) ? Number(res[0]?.affectedRows ?? 0) : Number(res?.affectedRows ?? 0);
    if (changed === 0) {
        // Lost a race with approve/another reject — report the current truth.
        const [fresh] = await db.select({ state: schema_js_1.payments.state }).from(schema_js_1.payments).where((0, drizzle_orm_1.eq)(schema_js_1.payments.id, payment.id)).limit(1);
        if (fresh?.state === 'REJECTED')
            return { ok: true, message: 'این پرداخت پیش‌تر رد شده است.' };
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('این پرداخت دیگر قابل رد نیست.'));
    }
    await (0, delivery_js_1.notifyTenant)({
        tenantId: payment.tenantId,
        kind: 'PAYMENT_REJECTED',
        titleFa: 'رسید پرداخت شما تأیید نشد',
        bodyFa: `رسید پرداخت شما تأیید نشد. دلیل: ${reason.trim().slice(0, 200)}`,
    }).catch(() => undefined);
    return { ok: true, message: 'پرداخت رد شد.' };
}
const AUDIT_ACTION_FA = {
    'admin.user_suspended': 'تعلیق کاربر', 'admin.user_activated': 'فعال‌سازی کاربر', 'admin.grant_subscription': 'هدیهٔ اشتراک',
    'admin.payment_approved': 'تأیید پرداخت', 'admin.payment_rejected': 'رد پرداخت', 'admin.plan_created': 'افزودن پلن', 'admin.plan_updated': 'ویرایش پلن', 'admin.plan_deleted': 'حذف پلن',
    'admin.settings_updated': 'به‌روزرسانی تنظیمات', 'admin.broadcast': 'ارسال پیام همگانی', 'admin.ticket_reply': 'پاسخ مدیر به تیکت', 'admin.ticket_close': 'بستن تیکت',
    'admin.channel_released': 'آزادسازی کانال', 'admin.email_test': 'آزمون ارسال ایمیل', 'admin.supporter_created': 'افزودن نیروی پشتیبانی', 'admin.supporter_role_changed': 'تغییر نقش نیروی پشتیبانی', 'admin.ticket_categories_updated': 'به‌روزرسانی دسته‌بندی تیکت',
    'admin.ticket_created': 'ایجاد تیکت از طرف مدیر', 'admin.ai_provider_saved': 'ذخیرهٔ سرویس‌دهندهٔ هوش مصنوعی', 'admin.ai_provider_deleted': 'حذف سرویس‌دهندهٔ هوش مصنوعی',
    'auth.login': 'ورود به حساب', 'auth.logout': 'خروج از حساب', 'auth.register': 'ثبت‌نام', 'auth.password_reset': 'بازیابی رمز عبور',
    'user.settings_updated': 'ویرایش تنظیمات حساب', 'user.password_changed': 'تغییر رمز عبور', 'user.avatar_updated': 'به‌روزرسانی تصویر نمایه', 'user.avatar_removed': 'حذف تصویر نمایه',
    'subscription.activated': 'فعال‌سازی اشتراک', 'payment.verified': 'تأیید پرداخت', 'payment.receipt_uploaded': 'بارگذاری رسید پرداخت',
    'channel.connect': 'اتصال کانال', 'channel.disconnect': 'قطع کانال', 'channel.update': 'ویرایش کانال', 'channel.verify': 'بررسی کانال',
    'bot.connect': 'اتصال ربات', 'bot.enable': 'فعال‌سازی ربات', 'bot.disable': 'غیرفعال‌سازی ربات', 'bot.verify': 'بررسی ربات', 'bot.mode': 'تغییر حالت ربات', 'bot.ai_settings': 'تنظیمات هوش مصنوعی ربات',
    'bot.command.create': 'افزودن دستور ربات', 'bot.command.update': 'ویرایش دستور ربات', 'bot.command.delete': 'حذف دستور ربات', 'bot.keyword.create': 'افزودن کلیدواژه', 'bot.keyword.update': 'ویرایش کلیدواژه', 'bot.keyword.delete': 'حذف کلیدواژه',
    'workflow.create': 'ساخت گردش‌کار', 'workflow.update': 'ویرایش گردش‌کار', 'workflow.delete': 'حذف گردش‌کار',
    'post.create': 'ایجاد پست', 'post.publish': 'انتشار پست', 'post.schedule': 'زمان‌بندی پست', 'post.cancel': 'لغو انتشار پست', 'post.target.retry': 'تلاش دوباره برای انتشار',
    'media.upload': 'بارگذاری فایل', 'media.delete': 'حذف فایل', 'wordpress.connected': 'اتصال سایت وردپرس', 'wordpress.disconnected': 'قطع سایت وردپرس', 'wordpress.secret_rotated': 'تغییر کلید اتصال وردپرس', 'wordpress.product_published': 'انتشار محصول وردپرس',
    'sync_products': 'همگام‌سازی محصولات', 'publish_product': 'انتشار محصول', 'referral.first_purchase_reward': 'پرداخت پاداش معرفی', 'referral.reward_failed': 'ناموفق بودن پاداش معرفی',
};
const ROLE_FA_SERVER = { SUPER_ADMIN: 'مدیر ارشد', SUPPORT: 'پشتیبانی', USER: 'کاربر', SYSTEM: 'سامانه' };
const SUBJECT_FA = {
    user: 'کاربر', workflow: 'گردش‌کار', bot: 'ربات', bot_command: 'دستور ربات', bot_keyword: 'کلیدواژه', channel: 'کانال', media: 'فایل رسانه‌ای', payment: 'پرداخت', plan: 'پلن', post: 'پست', post_target: 'هدف انتشار', referral: 'معرفی', subscription: 'اشتراک', ticket: 'تیکت', ai_job: 'درخواست هوش مصنوعی', ai_provider: 'سرویس‌دهنده هوش مصنوعی', wordpress_product: 'محصول وردپرس', wordpress_site: 'سایت وردپرس'
};
const PLATFORM_FA_SERVER = { telegram: 'تلگرام', bale: 'بله', rubika: 'روبیکا' };
const AI_PROVIDER_FA_SERVER = { openai: 'اُپن‌ای‌آی', deepseek: 'دیپ‌سیک', mistral: 'میسترال', openrouter: 'اوپن‌روتر', gemini: 'جمینی گوگل', anthropic: 'آنتروپیک کلود' };
const PURPOSE_FA_SERVER = { SUBSCRIPTION: 'اشتراک', WALLET_TOPUP: 'شارژ کیف پول', CAPTION: 'تولید عنوان/متن', AUTO_REPLY: 'پاسخ خودکار', CUSTOM: 'سفارشی' };
async function listAuditLogs(action, page, pageSize) {
    const db = (0, client_js_1.getDb)();
    const p = Math.max(1, page);
    const size = Math.min(100, Math.max(1, pageSize));
    const where = action?.trim() ? (0, drizzle_orm_1.eq)(schema_js_1.auditLogs.action, action.trim()) : undefined;
    const [totalRow] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.auditLogs).where(where);
    const rows = await db.select({ id: schema_js_1.auditLogs.id, actorId: schema_js_1.auditLogs.actorId, actorRole: schema_js_1.auditLogs.actorRole, action: schema_js_1.auditLogs.action, subjectType: schema_js_1.auditLogs.subjectType, subjectId: schema_js_1.auditLogs.subjectId, createdAt: schema_js_1.auditLogs.createdAt }).from(schema_js_1.auditLogs).where(where).orderBy((0, drizzle_orm_1.desc)(schema_js_1.auditLogs.createdAt)).limit(size).offset((p - 1) * size);
    const idsByType = new Map();
    const add = (type, id) => { if (!id)
        return; const a = idsByType.get(type) || []; if (!a.includes(id))
        a.push(id); idsByType.set(type, a); };
    for (const r of rows) {
        add('user', r.actorId);
        add(r.subjectType || '', r.subjectId);
    }
    const ids = (t) => idsByType.get(t) || [];
    const userRows = ids('user').length ? await db.select({ id: schema_js_1.users.id, firstName: schema_js_1.users.firstName, lastName: schema_js_1.users.lastName, email: schema_js_1.users.email }).from(schema_js_1.users).where((0, drizzle_orm_1.inArray)(schema_js_1.users.id, ids('user'))) : [];
    const workflowRows = ids('workflow').length ? await db.select({ id: schema_js_1.workflows.id, nameFa: schema_js_1.workflows.nameFa }).from(schema_js_1.workflows).where((0, drizzle_orm_1.inArray)(schema_js_1.workflows.id, ids('workflow'))) : [];
    const botRows = ids('bot').length ? await db.select({ id: schema_js_1.bots.id, title: schema_js_1.bots.title, platform: schema_js_1.bots.platform }).from(schema_js_1.bots).where((0, drizzle_orm_1.inArray)(schema_js_1.bots.id, ids('bot'))) : [];
    const cmdRows = ids('bot_command').length ? await db.select({ id: schema_js_1.botCommands.id, command: schema_js_1.botCommands.command }).from(schema_js_1.botCommands).where((0, drizzle_orm_1.inArray)(schema_js_1.botCommands.id, ids('bot_command'))) : [];
    const kwRows = ids('bot_keyword').length ? await db.select({ id: schema_js_1.botKeywords.id, keyword: schema_js_1.botKeywords.keyword }).from(schema_js_1.botKeywords).where((0, drizzle_orm_1.inArray)(schema_js_1.botKeywords.id, ids('bot_keyword'))) : [];
    const channelRows = ids('channel').length ? await db.select({ id: schema_js_1.channels.id, title: schema_js_1.channels.title, platform: schema_js_1.channels.platform }).from(schema_js_1.channels).where((0, drizzle_orm_1.inArray)(schema_js_1.channels.id, ids('channel'))) : [];
    const mediaRows = ids('media').length ? await db.select({ id: schema_js_1.media.id, filename: schema_js_1.media.filename }).from(schema_js_1.media).where((0, drizzle_orm_1.inArray)(schema_js_1.media.id, ids('media'))) : [];
    const paymentRows = ids('payment').length ? await db.select({ id: schema_js_1.payments.id, purpose: schema_js_1.payments.purpose, amountRial: schema_js_1.payments.amountRial }).from(schema_js_1.payments).where((0, drizzle_orm_1.inArray)(schema_js_1.payments.id, ids('payment'))) : [];
    const planRows = ids('plan').length ? await db.select({ id: schema_js_1.plans.id, nameFa: schema_js_1.plans.nameFa }).from(schema_js_1.plans).where((0, drizzle_orm_1.inArray)(schema_js_1.plans.id, ids('plan'))) : [];
    const postRows = ids('post').length ? await db.select({ id: schema_js_1.posts.id, title: schema_js_1.posts.title }).from(schema_js_1.posts).where((0, drizzle_orm_1.inArray)(schema_js_1.posts.id, ids('post'))) : [];
    const targetRows = ids('post_target').length ? await db.select({ id: schema_js_1.postTargets.id, channelId: schema_js_1.postTargets.channelId }).from(schema_js_1.postTargets).where((0, drizzle_orm_1.inArray)(schema_js_1.postTargets.id, ids('post_target'))) : [];
    const ticketRows = ids('ticket').length ? await db.select({ id: schema_js_1.tickets.id, subject: schema_js_1.tickets.subject }).from(schema_js_1.tickets).where((0, drizzle_orm_1.inArray)(schema_js_1.tickets.id, ids('ticket'))) : [];
    const aiRows = ids('ai_job').length ? await db.select({ id: schema_js_1.aiJobs.id, purpose: schema_js_1.aiJobs.purpose, provider: schema_js_1.aiJobs.provider }).from(schema_js_1.aiJobs).where((0, drizzle_orm_1.inArray)(schema_js_1.aiJobs.id, ids('ai_job'))) : [];
    const refRows = ids('referral').length ? await db.select({ id: schema_js_1.referrals.id }).from(schema_js_1.referrals).where((0, drizzle_orm_1.inArray)(schema_js_1.referrals.id, ids('referral'))) : [];
    const wpSiteRows = ids('wordpress_site').length ? await db.select({ id: schema_js_1.wordpressSites.id, siteUrl: schema_js_1.wordpressSites.siteUrl }).from(schema_js_1.wordpressSites).where((0, drizzle_orm_1.inArray)(schema_js_1.wordpressSites.id, ids('wordpress_site'))) : [];
    const wpProductRows = ids('wordpress_product').length ? await db.select({ id: schema_js_1.wordpressProducts.id, title: schema_js_1.wordpressProducts.title }).from(schema_js_1.wordpressProducts).where((0, drizzle_orm_1.inArray)(schema_js_1.wordpressProducts.id, ids('wordpress_product'))) : [];
    const subRows = ids('subscription').length ? await db.select({ id: schema_js_1.subscriptions.id, tenantId: schema_js_1.subscriptions.tenantId, planId: schema_js_1.subscriptions.planId }).from(schema_js_1.subscriptions).where((0, drizzle_orm_1.inArray)(schema_js_1.subscriptions.id, ids('subscription'))) : [];
    const mapBy = (arr) => new Map(arr.map(x => [x.id, x]));
    const userMap = mapBy(userRows), wfMap = mapBy(workflowRows), botMap = mapBy(botRows), cmdMap = mapBy(cmdRows), kwMap = mapBy(kwRows), chMap = mapBy(channelRows), mediaMap = mapBy(mediaRows), payMap = mapBy(paymentRows), planMap = mapBy(planRows), postMap = mapBy(postRows), targetMap = mapBy(targetRows), ticketMap = mapBy(ticketRows), aiMap = mapBy(aiRows), wpSiteMap = mapBy(wpSiteRows), wpProductMap = mapBy(wpProductRows), subMap = mapBy(subRows);
    const labelUser = (id) => { if (!id)
        return 'سامانه'; const u = userMap.get(id); return u ? (`${u.firstName} ${u.lastName}`.trim() || u.email) : 'کاربر سامانه'; };
    const labelSubject = (t, id) => {
        if (!t)
            return '—';
        if (t === 'user')
            return labelUser(id);
        const x = id || '';
        if (t === 'workflow')
            return wfMap.get(x)?.nameFa || 'گردش‌کار';
        if (t === 'bot') {
            const b = botMap.get(x);
            return b ? `${b.title} (${PLATFORM_FA_SERVER[b.platform] || 'پلتفرم'})` : 'ربات';
        }
        if (t === 'bot_command')
            return cmdMap.get(x) ? `دستور «${cmdMap.get(x).command}»` : 'دستور ربات';
        if (t === 'bot_keyword')
            return kwMap.get(x) ? `کلیدواژه «${kwMap.get(x).keyword}»` : 'کلیدواژه';
        if (t === 'channel') {
            const c = chMap.get(x);
            return c ? `${c.title} — ${PLATFORM_FA_SERVER[c.platform] || 'پلتفرم'}` : 'کانال';
        }
        if (t === 'media')
            return mediaMap.get(x)?.filename || 'فایل رسانه‌ای';
        if (t === 'payment') {
            const q = payMap.get(x);
            return q ? `${PURPOSE_FA_SERVER[q.purpose] || 'پرداخت'} — ${num(q.amountRial).toLocaleString('fa-IR')} ریال` : 'پرداخت';
        }
        if (t === 'plan')
            return planMap.get(x)?.nameFa || 'پلن';
        if (t === 'post')
            return postMap.get(x)?.title || 'پست بدون عنوان';
        if (t === 'post_target') {
            const tr = targetMap.get(x);
            const c = tr ? chMap.get(tr.channelId) : null;
            return c ? `انتشار در «${c.title}»` : 'هدف انتشار';
        }
        if (t === 'ticket')
            return ticketMap.get(x)?.subject || 'تیکت';
        if (t === 'ai_job') {
            const a = aiMap.get(x);
            return a ? `${PURPOSE_FA_SERVER[a.purpose] || 'درخواست هوش مصنوعی'} — ${AI_PROVIDER_FA_SERVER[a.provider] || 'سرویس‌دهنده'}` : 'درخواست هوش مصنوعی';
        }
        if (t === 'wordpress_site')
            return 'سایت وردپرس';
        if (t === 'wordpress_product')
            return wpProductMap.get(x)?.title || 'محصول وردپرس';
        if (t === 'subscription') {
            const ss = subMap.get(x);
            return ss ? `اشتراک ${planMap.get(ss.planId)?.nameFa || ''}`.trim() : 'اشتراک';
        }
        if (t === 'ai_provider')
            return 'سرویس‌دهندهٔ هوش مصنوعی';
        if (t === 'referral')
            return 'رویداد معرفی';
        return SUBJECT_FA[t] || 'موضوع رویداد';
    };
    return { items: rows.map(r => ({ id: r.id, actorLabel: labelUser(r.actorId), actorRoleFa: ROLE_FA_SERVER[r.actorRole || ''] || 'سامانه', actionFa: AUDIT_ACTION_FA[r.action] || 'رویداد سامانه', subjectTypeFa: SUBJECT_FA[r.subjectType || ''] || 'رویداد سامانه', subjectLabel: labelSubject(r.subjectType, r.subjectId), createdAt: r.createdAt })), total: Number(totalRow?.value ?? 0), page: p, pageSize: size };
}
async function deleteAuditLog(id) {
    const db = (0, client_js_1.getDb)();
    await db.delete(schema_js_1.auditLogs).where((0, drizzle_orm_1.eq)(schema_js_1.auditLogs.id, id));
}
async function deleteAuditLogsBulk(options) {
    const db = (0, client_js_1.getDb)();
    const conds = [];
    if (options.ids && options.ids.length > 0) {
        conds.push((0, drizzle_orm_1.inArray)(schema_js_1.auditLogs.id, options.ids));
    }
    else if (options.all) {
        if (options.action?.trim()) {
            conds.push((0, drizzle_orm_1.eq)(schema_js_1.auditLogs.action, options.action.trim()));
        }
    }
    else if (options.olderThanDays && options.olderThanDays > 0) {
        const cutoff = new Date(Date.now() - options.olderThanDays * 86400_000);
        conds.push((0, drizzle_orm_1.lte)(schema_js_1.auditLogs.createdAt, cutoff));
        if (options.action?.trim()) {
            conds.push((0, drizzle_orm_1.eq)(schema_js_1.auditLogs.action, options.action.trim()));
        }
    }
    else {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('شرط پاکسازی گزارشات مشخص نشده است.'));
    }
    const whereClause = conds.length > 1 ? (0, drizzle_orm_1.and)(...conds) : conds[0];
    const res = whereClause ? await db.delete(schema_js_1.auditLogs).where(whereClause) : await db.delete(schema_js_1.auditLogs);
    const count = res?.[0]?.affectedRows ?? res?.affectedRows ?? 0;
    return { deletedCount: Number(count) };
}
async function listPlans() {
    const db = (0, client_js_1.getDb)();
    const rows = await db.select().from(schema_js_1.plans).orderBy(schema_js_1.plans.sortOrder);
    return rows.map((r) => ({
        ...r,
        priceRial: Number(r.priceRial),
        featuresJson: (0, plan_service_js_1.normalizePlanFeatures)(r.featuresJson),
    }));
}
const PLAN_LIMIT_KEYS = ['max_channels', 'max_posts', 'max_bots', 'max_schedules', 'ai_monthly', 'storage_mb'];
const DEFAULT_PLAN_LIMITS = {
    max_channels: 1,
    max_posts: 30,
    max_bots: 1,
    max_schedules: 10,
    ai_monthly: 50,
    storage_mb: 512,
};
const DEFAULT_PLAN_FEATURES = {
    gold_ticker: false,
    auto_responder: false,
    woocommerce: false,
    wordpress_campaigns: false,
    content_summarization: false,
};
const PLAN_FEATURE_KEYS = [
    'gold_ticker',
    'auto_responder',
    'woocommerce',
    'wordpress_campaigns',
    'content_summarization',
];
/**
 * Only known plan flags may be stored. Ignore the retired api_access key from
 * stale admin tabs, but reject any other unexpected key. Unknown feature keys
 * must never become effective merely because they are supplied in JSON.
 */
function normalizePlanFeatureInput(raw, base = DEFAULT_PLAN_FEATURES) {
    const source = raw ?? {};
    for (const [key, value] of Object.entries(source)) {
        if (key === 'api_access')
            continue; // retired, ignored for safe backward compatibility
        if (!PLAN_FEATURE_KEYS.includes(key)) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('کلید ناشناخته در امکانات پلن مجاز نیست.'));
        }
        if (typeof value !== 'boolean') {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مقدار امکانات پلن باید روشن یا خاموش باشد.'));
        }
    }
    const current = (0, plan_service_js_1.normalizePlanFeatures)(base);
    const result = { ...current };
    for (const key of PLAN_FEATURE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            result[key] = source[key];
        }
    }
    return result;
}
function numericLimit(record, keys) {
    return Object.entries(record).every(([k, v]) => keys.includes(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0);
}
/**
 * Round 19 — strict admin-input validation for the discount model.
 *  - renewalDiscountPercent: integer 0-90 (optional, default 0);
 *  - durationDiscounts: object months(1-36) → percent(0-90), ≤12 rows.
 * Throws a Persian 422 on the first offending field.
 */
function validatePlanPricingInput(raw) {
    const renewalRaw = raw.renewalDiscountPercent;
    const renewal = renewalRaw === undefined ? 0 : Number(renewalRaw);
    if (!Number.isInteger(renewal) || renewal < 0 || renewal > 90) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('درصد تخفیف تمدید باید عددی بین ۰ تا ۹۰ باشد.'));
    }
    const durationSrc = raw.durationDiscounts;
    if (durationSrc !== undefined && (typeof durationSrc !== 'object' || durationSrc === null || Array.isArray(durationSrc))) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('قالب تخفیف‌های مدت خرید معتبر نیست.'));
    }
    const durationDiscounts = {};
    const entries = Object.entries((durationSrc ?? {}));
    if (entries.length > 12) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('حداکثر ۱۲ ردیف تخفیف مدت خرید مجاز است.'));
    }
    for (const [k, v] of entries) {
        const months = Number(k);
        const pct = Number(v);
        if (!Number.isInteger(months) || months < 1 || months > 36) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مدت تخفیف باید عددی بین ۱ تا ۳۶ ماه باشد.'));
        }
        if (!Number.isInteger(pct) || pct < 0 || pct > 90) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`درصد تخفیف برای «${months} ماه» باید عددی بین ۰ تا ۹۰ باشد.`));
        }
        durationDiscounts[String(months)] = pct;
    }
    return { renewalDiscountPercent: renewal, durationDiscounts };
}
async function createPlan(input) {
    const db = (0, client_js_1.getDb)();
    const code = input.code.trim();
    const [existing] = await db.select({ id: schema_js_1.plans.id }).from(schema_js_1.plans).where((0, drizzle_orm_1.eq)(schema_js_1.plans.code, code)).limit(1);
    if (existing)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('کد پلن تکراری است.'));
    const limits = { ...DEFAULT_PLAN_LIMITS, ...(input.limitsJson ?? {}) };
    if (!numericLimit(limits, PLAN_LIMIT_KEYS)) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('قالب محدودیت‌های پلن معتبر نیست.'));
    }
    const features = normalizePlanFeatureInput(input.featuresJson);
    const pricing = validatePlanPricingInput(input.pricingJson ?? {});
    const id = (0, ids_js_1.newId)();
    await db.insert(schema_js_1.plans).values({
        id,
        code,
        nameFa: input.nameFa.trim().slice(0, 80),
        priceRial: Math.max(0, Math.floor(input.priceRial)),
        periodDays: Math.min(3650, Math.max(1, Math.floor(input.periodDays))),
        limitsJson: limits,
        featuresJson: features,
        pricingJson: pricing,
        sortOrder: 0,
        isActive: 1,
    });
    return { id };
}
async function deletePlan(planId) {
    const db = (0, client_js_1.getDb)();
    const [plan] = await db.select({ id: schema_js_1.plans.id }).from(schema_js_1.plans).where((0, drizzle_orm_1.eq)(schema_js_1.plans.id, planId)).limit(1);
    if (!plan)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پلن'));
    // Any subscription row (ACTIVE, EXPIRED or CANCELLED) keeps the plan alive —
    // history must stay resolvable; deactivate the plan instead of deleting it.
    const [refRow] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.subscriptions).where((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.planId, planId));
    if (Number(refRow?.value ?? 0) > 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('به این پلن اشتراک فعال متصل است؛ ابتدا آن اشتراک‌ها را بررسی کنید یا پلن را غیرفعال کنید.'));
    }
    await db.delete(schema_js_1.plans).where((0, drizzle_orm_1.eq)(schema_js_1.plans.id, planId));
}
async function updatePlan(planId, patch) {
    const db = (0, client_js_1.getDb)();
    const [plan] = await db.select({ id: schema_js_1.plans.id, featuresJson: schema_js_1.plans.featuresJson }).from(schema_js_1.plans).where((0, drizzle_orm_1.eq)(schema_js_1.plans.id, planId)).limit(1);
    if (!plan)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('پلن'));
    const update = {};
    if (patch.nameFa !== undefined)
        update.nameFa = patch.nameFa.trim().slice(0, 80);
    if (patch.priceRial !== undefined)
        update.priceRial = Math.max(0, Math.floor(patch.priceRial));
    if (patch.periodDays !== undefined)
        update.periodDays = Math.min(3650, Math.max(1, Math.floor(patch.periodDays)));
    if (patch.isActive !== undefined)
        update.isActive = patch.isActive ? 1 : 0;
    if (patch.limitsJson !== undefined) {
        if (!numericLimit(patch.limitsJson, PLAN_LIMIT_KEYS)) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('قالب محدودیت‌های پلن معتبر نیست.'));
        }
        update.limitsJson = patch.limitsJson;
    }
    if (patch.featuresJson !== undefined) {
        update.featuresJson = normalizePlanFeatureInput(patch.featuresJson, (0, plan_service_js_1.normalizePlanFeatures)(plan.featuresJson));
    }
    if (patch.pricingJson !== undefined) {
        update.pricingJson = validatePlanPricingInput(patch.pricingJson);
    }
    if (Object.keys(update).length === 0)
        return;
    await db.update(schema_js_1.plans).set(update).where((0, drizzle_orm_1.eq)(schema_js_1.plans.id, planId));
}
const MAX_SETTINGS_KEYS = 100;
async function getSettings() {
    const db = (0, client_js_1.getDb)();
    const rows = await db.select().from(schema_js_1.systemSettings);
    const map = {};
    for (const r of rows) {
        if (r.settingKey.startsWith('notif_pref:'))
            continue; // per-tenant data stays hidden
        if (r.settingKey === 'cardToCardCards')
            continue; // re-added below in coerced API shape
        map[r.settingKey] = r.valueJson;
    }
    // Payment gateway settings always surface in their contract shape
    // (contract 14-contract item 2), even if the 0003 seed rows are missing.
    const ps = await (0, payment_settings_service_js_1.getPaymentSettings)();
    map.paymentOnlineEnabled = ps.onlineEnabled;
    map.paymentCardToCardEnabled = ps.cardToCardEnabled;
    map.paymentProvider = ps.provider;
    map.cardToCardCards = ps.cards;
    return map;
}
async function putSettings(map) {
    const db = (0, client_js_1.getDb)();
    const entries = Object.entries(map).filter(([k]) => k.length > 0 && k.length <= 80 && !k.startsWith('notif_pref:'));
    if (entries.length > MAX_SETTINGS_KEYS) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('تعداد کلیدهای تنظیمات بیش از حد مجاز است.'));
    }
    for (const [key, value] of entries) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`مقدار کلید «${key}» باید یک شیء JSON باشد.`));
        }
        await db
            .insert(schema_js_1.systemSettings)
            .values({ settingKey: key, valueJson: value })
            .onDuplicateKeyUpdate({ set: { valueJson: value } });
    }
    return entries.length;
}
const BROADCAST_BATCH = 500;
const BROADCAST_MAX_BATCHES = 1000; // hard bound: 500k users
async function notifyBatched(extraWhere, titleFa, bodyFa) {
    const db = (0, client_js_1.getDb)();
    let notified = 0;
    let cursor = '';
    for (let batch = 0; batch < BROADCAST_MAX_BATCHES; batch++) {
        const conds = [
            (0, drizzle_orm_1.eq)(schema_js_1.users.status, 'ACTIVE'),
            ...(extraWhere ? [extraWhere] : []),
            ...(cursor ? [(0, drizzle_orm_1.sql) `${schema_js_1.users.id} > ${cursor}`] : []),
        ];
        const rows = await db
            .select({ id: schema_js_1.users.id })
            .from(schema_js_1.users)
            .where((0, drizzle_orm_1.and)(...conds))
            .orderBy(schema_js_1.users.id)
            .limit(BROADCAST_BATCH);
        if (rows.length === 0)
            break;
        for (const r of rows) {
            await (0, delivery_js_1.notifyTenant)({ tenantId: r.id, kind: 'BROADCAST', titleFa, bodyFa });
            notified++;
        }
        const lastUser = rows[rows.length - 1];
        if (!lastUser)
            break;
        cursor = lastUser.id;
        if (rows.length < BROADCAST_BATCH)
            break;
    }
    return notified;
}
/**
 * Broadcast (§27, extended round 19): targeted notifications.
 *  - ALL: every ACTIVE user (original behavior);
 *  - ROLE: ACTIVE users with the given role (گروه کاربری);
 *  - PLAN: tenants with an ACTIVE subscription on the plan (گروه اشتراک);
 *  - USERS: explicit member list — sent regardless of status, because the
 *    admin deliberately picked each recipient (اعضای خاص).
 */
async function broadcast(actorId, titleFa, bodyFa, target = { kind: 'ALL' }) {
    const db = (0, client_js_1.getDb)();
    let notified = 0;
    if (target.kind === 'USERS') {
        const ids = Array.from(new Set(target.userIds));
        for (const id of ids) {
            await (0, delivery_js_1.notifyTenant)({ tenantId: id, kind: 'BROADCAST', titleFa, bodyFa });
            notified++;
        }
        void actorId;
        return notified;
    }
    if (target.kind === 'PLAN') {
        // ACTIVE subscriptions on the plan, joined to ACTIVE users; paged by
        // cursor on subscriptions.id to stay within bounded batches.
        let cursor = '';
        for (let batch = 0; batch < BROADCAST_MAX_BATCHES; batch++) {
            const conds = [
                (0, drizzle_orm_1.eq)(schema_js_1.subscriptions.planId, target.planId),
                (0, drizzle_orm_1.eq)(schema_js_1.subscriptions.state, 'ACTIVE'),
                (0, drizzle_orm_1.gt)(schema_js_1.subscriptions.expiresAt, new Date()),
                ...(cursor ? [(0, drizzle_orm_1.sql) `${schema_js_1.subscriptions.id} > ${cursor}`] : []),
            ];
            const rows = await db
                .select({ subId: schema_js_1.subscriptions.id, tenantId: schema_js_1.subscriptions.tenantId, status: schema_js_1.users.status })
                .from(schema_js_1.subscriptions)
                .innerJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.subscriptions.tenantId))
                .where((0, drizzle_orm_1.and)(...conds))
                .orderBy(schema_js_1.subscriptions.id)
                .limit(BROADCAST_BATCH);
            if (rows.length === 0)
                break;
            for (const r of rows) {
                if (r.status !== 'ACTIVE')
                    continue;
                await (0, delivery_js_1.notifyTenant)({ tenantId: r.tenantId, kind: 'BROADCAST', titleFa, bodyFa });
                notified++;
            }
            const lastSub = rows[rows.length - 1];
            if (!lastSub)
                break;
            cursor = lastSub.subId;
            if (rows.length < BROADCAST_BATCH)
                break;
        }
        void actorId;
        return notified;
    }
    notified = await notifyBatched(target.kind === 'ROLE' ? (0, drizzle_orm_1.eq)(schema_js_1.users.role, target.role) : undefined, titleFa, bodyFa);
    return notified;
}
/**
 * Round 19 — target-picker data for the broadcast page: ACTIVE-user counts per
 * role and per active plan (one grouped query each + the plan catalog).
 */
async function getBroadcastTargets() {
    const db = (0, client_js_1.getDb)();
    const roleRows = await db
        .select({ role: schema_js_1.users.role, value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.status, 'ACTIVE'))
        .groupBy(schema_js_1.users.role);
    const planRows = await db.select({ id: schema_js_1.plans.id, nameFa: schema_js_1.plans.nameFa }).from(schema_js_1.plans).where((0, drizzle_orm_1.eq)(schema_js_1.plans.isActive, 1)).orderBy(schema_js_1.plans.sortOrder);
    const subRows = await db
        .select({ planId: schema_js_1.subscriptions.planId, value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.subscriptions)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.state, 'ACTIVE'), (0, drizzle_orm_1.gt)(schema_js_1.subscriptions.expiresAt, new Date())))
        .groupBy(schema_js_1.subscriptions.planId);
    const subByPlan = new Map(subRows.map((r) => [r.planId, Number(r.value)]));
    return {
        roles: roleRows.map((r) => ({ role: r.role, count: Number(r.value) })),
        plans: planRows.map((p) => ({ id: p.id, nameFa: p.nameFa, subscribers: subByPlan.get(p.id) ?? 0 })),
    };
}
async function releaseChannel(actorId, platform, channelRef) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({ tenantId: schema_js_1.channelRegistry.tenantId })
        .from(schema_js_1.channelRegistry)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelRegistry.platform, platform), (0, drizzle_orm_1.eq)(schema_js_1.channelRegistry.channelRef, channelRef)))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کانال در دفتر ثبت کانال‌ها'));
    await db
        .update(schema_js_1.channelRegistry)
        .set({ tenantId: null, releasedAt: new Date() })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelRegistry.platform, platform), (0, drizzle_orm_1.eq)(schema_js_1.channelRegistry.channelRef, channelRef)));
    void actorId;
}
