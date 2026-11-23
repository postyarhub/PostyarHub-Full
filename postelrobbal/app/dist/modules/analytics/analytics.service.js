"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.summarizeAutomationEvents = summarizeAutomationEvents;
exports.recordAnalyticsEvent = recordAnalyticsEvent;
exports.getTenantAnalytics = getTenantAnalytics;
exports.getPostAnalytics = getPostAnalytics;
exports.getCampaignAnalytics = getCampaignAnalytics;
exports.getWordPressAnalytics = getWordPressAnalytics;
exports.getAdminAnalytics = getAdminAnalytics;
exports.createTrackedLink = createTrackedLink;
exports.getLinkStats = getLinkStats;
exports.resolveTrackedLink = resolveTrackedLink;
exports.recordTrackedLinkClick = recordTrackedLinkClick;
const node_crypto_1 = require("node:crypto");
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const errors_js_1 = require("../../core/errors.js");
const ANALYTICS_MAX_DAYS = 90;
const META_MAX_BYTES = 8192;
const LINK_TOKEN_BYTES = 18;
const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,96}$/;
function toFiniteInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function cleanMetadata(value, depth = 0) {
    if (depth > 4)
        return null;
    if (value === null || typeof value === 'boolean')
        return value;
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    if (typeof value === 'string')
        return value.length > 800 ? value.slice(0, 800) : value;
    if (Array.isArray(value))
        return value.slice(0, 50).map((item) => cleanMetadata(item, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (/secret|token|password|credential|authorization|cookie|api[_-]?key/i.test(key))
                continue;
            out[key.slice(0, 80)] = cleanMetadata(item, depth + 1);
            if (Object.keys(out).length >= 100)
                break;
        }
        return out;
    }
    return null;
}
function metadataJson(metadata) {
    if (!metadata)
        return null;
    try {
        const raw = JSON.stringify(cleanMetadata(metadata));
        if (!raw)
            return null;
        return Buffer.byteLength(raw, 'utf8') > META_MAX_BYTES ? raw.slice(0, META_MAX_BYTES) : raw;
    }
    catch {
        return null;
    }
}
function safeWindow(days) {
    return Math.min(ANALYTICS_MAX_DAYS, Math.max(1, Math.trunc(days || 30)));
}
function sinceDate(days) {
    return new Date(Date.now() - safeWindow(days) * 86_400_000);
}
function summarizeAutomationRows(rows) {
    let aiRequested = 0;
    let aiCompleted = 0;
    let aiFailed = 0;
    let aiTokens = 0;
    let aiDurationTotal = 0;
    let aiDurationCount = 0;
    let workflowStarted = 0;
    let workflowCompleted = 0;
    let workflowFailed = 0;
    let workflowDurationTotal = 0;
    let workflowDurationCount = 0;
    const errors = new Map();
    for (const row of rows) {
        const meta = parseMetadata(row.metadataJson);
        const durationMs = numeric(meta.durationMs);
        const errorCode = typeof meta.errorCode === 'string' && meta.errorCode ? meta.errorCode : '';
        switch (row.eventType) {
            case 'ai.requested':
                aiRequested += 1;
                break;
            case 'ai.completed':
                aiCompleted += 1;
                aiTokens += numeric(meta.tokenCount) || numeric(row.value);
                if (durationMs > 0) {
                    aiDurationTotal += durationMs;
                    aiDurationCount += 1;
                }
                break;
            case 'ai.failed':
                aiFailed += 1;
                if (errorCode) {
                    const key = `ai.failed:${errorCode}`;
                    const prev = errors.get(key);
                    errors.set(key, prev ? { ...prev, count: prev.count + 1 } : { eventType: row.eventType, errorCode, count: 1 });
                }
                break;
            case 'workflow.started':
                workflowStarted += 1;
                break;
            case 'workflow.completed':
                workflowCompleted += 1;
                if (durationMs > 0) {
                    workflowDurationTotal += durationMs;
                    workflowDurationCount += 1;
                }
                break;
            case 'workflow.failed':
                workflowFailed += 1;
                if (errorCode) {
                    const key = `workflow.failed:${errorCode}`;
                    const prev = errors.get(key);
                    errors.set(key, prev ? { ...prev, count: prev.count + 1 } : { eventType: row.eventType, errorCode, count: 1 });
                }
                break;
            default:
                if (row.eventType.endsWith('.failed') && errorCode) {
                    const key = `${row.eventType}:${errorCode}`;
                    const prev = errors.get(key);
                    errors.set(key, prev ? { ...prev, count: prev.count + 1 } : { eventType: row.eventType, errorCode, count: 1 });
                }
        }
    }
    const errorList = Array.from(errors.values())
        .sort((a, b) => b.count - a.count || a.errorCode.localeCompare(b.errorCode))
        .slice(0, 12);
    return {
        ai: {
            requested: aiRequested,
            completed: aiCompleted,
            failed: aiFailed,
            successRate: aiRequested > 0 ? aiCompleted / aiRequested : null,
            tokens: aiTokens,
            avgDurationMs: aiDurationCount > 0 ? Math.round(aiDurationTotal / aiDurationCount) : null,
        },
        workflows: {
            started: workflowStarted,
            completed: workflowCompleted,
            failed: workflowFailed,
            successRate: workflowStarted > 0 ? workflowCompleted / workflowStarted : null,
            avgDurationMs: workflowDurationCount > 0 ? Math.round(workflowDurationTotal / workflowDurationCount) : null,
        },
        errors: errorList,
    };
}
function summarizeAutomationEvents(rows) {
    return summarizeAutomationRows(rows);
}
function parseMetadata(raw) {
    if (typeof raw !== 'string' || raw.length === 0)
        return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function numeric(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}
function summarizeRevenue(rows) {
    const out = {
        paymentsCreated: 0,
        paymentsCompleted: 0,
        paymentsCompletedRial: 0,
        subscriptionRevenueRial: 0,
        walletTopupRial: 0,
        paymentsFailed: 0,
        subscriptionsCreated: 0,
        subscriptionsRenewed: 0,
        subscriptionsExpired: 0,
        referralsCreated: 0,
        referralRewardEvents: 0,
        referralRewardPoints: 0,
    };
    for (const row of rows) {
        const value = numeric(row.value);
        const meta = parseMetadata(row.metadataJson);
        switch (row.eventType) {
            case 'payment.created':
                out.paymentsCreated += 1;
                break;
            case 'payment.completed': {
                out.paymentsCompleted += 1;
                out.paymentsCompletedRial += value;
                const purpose = typeof meta.purpose === 'string' ? meta.purpose : '';
                if (purpose === 'SUBSCRIPTION')
                    out.subscriptionRevenueRial += value;
                if (purpose === 'WALLET_TOPUP')
                    out.walletTopupRial += value;
                break;
            }
            case 'payment.failed':
                out.paymentsFailed += 1;
                break;
            case 'subscription.created':
                out.subscriptionsCreated += 1;
                break;
            case 'subscription.renewed':
                out.subscriptionsRenewed += 1;
                break;
            case 'subscription.expired':
                out.subscriptionsExpired += 1;
                break;
            case 'referral.created':
                out.referralsCreated += 1;
                break;
            case 'referral.rewarded':
                out.referralRewardEvents += 1;
                out.referralRewardPoints += numeric(meta.points) || value;
                break;
        }
    }
    return out;
}
function ipHash(ip) {
    if (!ip)
        return null;
    return (0, node_crypto_1.createHash)('sha256').update(ip).digest('hex');
}
function randomToken() {
    return (0, node_crypto_1.randomBytes)(LINK_TOKEN_BYTES).toString('base64url');
}
async function recordAnalyticsEvent(input) {
    const db = (0, client_js_1.getDb)();
    const normalizedValue = typeof input.value === 'bigint'
        ? input.value
        : BigInt(Math.max(-9_000_000_000_000_000, Math.min(9_000_000_000_000_000, toFiniteInt(input.value, 1))));
    await db.insert(schema_js_1.analyticsEvents).values({
        id: (0, ids_js_1.newId)(),
        userId: input.userId ?? null,
        eventType: input.eventType.slice(0, 64),
        occurredAt: input.occurredAt ?? new Date(),
        postId: input.postId ?? null,
        targetId: input.targetId ?? null,
        channelId: input.channelId ?? null,
        campaignId: input.campaignId ?? null,
        linkId: input.linkId ?? null,
        platform: input.platform?.slice(0, 24) ?? null,
        source: input.source?.slice(0, 32) ?? null,
        value: normalizedValue,
        metadataJson: metadataJson(input.metadata),
        dedupeKey: input.dedupeKey?.slice(0, 191) ?? null,
    });
}
function emptyPlatformMap() {
    return { telegram: { sent: 0, failed: 0 }, bale: { sent: 0, failed: 0 }, rubika: { sent: 0, failed: 0 }, wordpress: { sent: 0, failed: 0 } };
}
function errorKey(name) {
    return name.replace(/^post\./, '').replace(/^wordpress\./, 'wordpress.');
}
async function getTenantAnalytics(tenantId, days = 30) {
    const windowDays = safeWindow(days);
    const since = sinceDate(windowDays);
    const db = (0, client_js_1.getDb)();
    const [eventRows, dailyRows, postRows, campaignRows] = await Promise.all([
        db.select({ eventType: schema_js_1.analyticsEvents.eventType, value: schema_js_1.analyticsEvents.value, metadataJson: schema_js_1.analyticsEvents.metadataJson }).from(schema_js_1.analyticsEvents).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since))),
        db.select({ day: (0, drizzle_orm_1.sql) `DATE(${schema_js_1.analyticsEvents.occurredAt})`, eventName: schema_js_1.analyticsEvents.eventType, count: (0, drizzle_orm_1.sql) `COUNT(*)` }).from(schema_js_1.analyticsEvents).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since))).groupBy((0, drizzle_orm_1.sql) `DATE(${schema_js_1.analyticsEvents.occurredAt})`, schema_js_1.analyticsEvents.eventType).orderBy((0, drizzle_orm_1.asc)((0, drizzle_orm_1.sql) `DATE(${schema_js_1.analyticsEvents.occurredAt})`)),
        db.select({ postId: schema_js_1.analyticsEvents.postId, count: (0, drizzle_orm_1.sql) `COUNT(*)` }).from(schema_js_1.analyticsEvents).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since), (0, drizzle_orm_1.sql) `${schema_js_1.analyticsEvents.postId} IS NOT NULL`)).groupBy(schema_js_1.analyticsEvents.postId).orderBy((0, drizzle_orm_1.desc)((0, drizzle_orm_1.sql) `COUNT(*)`)).limit(10),
        db.select({ campaignId: schema_js_1.analyticsEvents.campaignId, count: (0, drizzle_orm_1.sql) `COUNT(*)` }).from(schema_js_1.analyticsEvents).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since), (0, drizzle_orm_1.sql) `${schema_js_1.analyticsEvents.campaignId} IS NOT NULL`)).groupBy(schema_js_1.analyticsEvents.campaignId).orderBy((0, drizzle_orm_1.desc)((0, drizzle_orm_1.sql) `COUNT(*)`)).limit(10),
    ]);
    const [linkRows, platformRows, errorRows] = await Promise.all([
        db.select({ clicks: (0, drizzle_orm_1.sql) `COALESCE(SUM(${schema_js_1.analyticsLinks.clickCount}), 0)` }).from(schema_js_1.analyticsLinks).where((0, drizzle_orm_1.eq)(schema_js_1.analyticsLinks.userId, tenantId)),
        db.select({ platform: schema_js_1.analyticsEvents.platform, eventType: schema_js_1.analyticsEvents.eventType, count: (0, drizzle_orm_1.sql) `COUNT(*)` }).from(schema_js_1.analyticsEvents).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since), (0, drizzle_orm_1.inArray)(schema_js_1.analyticsEvents.eventType, ['post.sent', 'post.failed']))).groupBy(schema_js_1.analyticsEvents.platform, schema_js_1.analyticsEvents.eventType),
        db.select({ eventType: schema_js_1.analyticsEvents.eventType, count: (0, drizzle_orm_1.sql) `COUNT(*)` }).from(schema_js_1.analyticsEvents).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since), (0, drizzle_orm_1.inArray)(schema_js_1.analyticsEvents.eventType, ['post.failed', 'wordpress.campaign.run.failed', 'wordpress.product.failed', 'wordpress.content.failed']))).groupBy(schema_js_1.analyticsEvents.eventType).orderBy((0, drizzle_orm_1.desc)((0, drizzle_orm_1.sql) `COUNT(*)`)).limit(8),
    ]);
    // `value` is semantic payload (for example Rial or points), not an event count.
    // Event KPIs must therefore count rows rather than summing value.
    const totalEvents = eventRows.length;
    const automation = summarizeAutomationRows(eventRows);
    const sent = eventRows.filter((row) => row.eventType === 'post.sent').length;
    const failed = eventRows.filter((row) => row.eventType === 'post.failed').length;
    const platforms = emptyPlatformMap();
    for (const row of platformRows) {
        const platform = String(row.platform ?? '');
        if (!(platform in platforms))
            continue;
        const key = row.eventType === 'post.sent' ? 'sent' : 'failed';
        const bucket = platforms[platform];
        if (bucket)
            bucket[key] = toFiniteInt(row.count);
    }
    const topPostIds = postRows.map((r) => r.postId).filter((v) => Boolean(v));
    const topCampaignIds = campaignRows.map((r) => r.campaignId).filter((v) => Boolean(v));
    const [topPosts, topCampaigns] = await Promise.all([
        topPostIds.length
            ? db.select({ id: schema_js_1.posts.id, title: schema_js_1.posts.title, count: (0, drizzle_orm_1.sql) `COUNT(${schema_js_1.analyticsEvents.id})` })
                .from(schema_js_1.analyticsEvents)
                .innerJoin(schema_js_1.posts, (0, drizzle_orm_1.eq)(schema_js_1.posts.id, schema_js_1.analyticsEvents.postId))
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since), (0, drizzle_orm_1.inArray)(schema_js_1.analyticsEvents.postId, topPostIds)))
                .groupBy(schema_js_1.posts.id, schema_js_1.posts.title)
                .orderBy((0, drizzle_orm_1.desc)((0, drizzle_orm_1.sql) `COUNT(${schema_js_1.analyticsEvents.id})`))
                .limit(10)
            : Promise.resolve([]),
        topCampaignIds.length
            ? db.select({ id: schema_js_1.wordpressCampaigns.id, name: schema_js_1.wordpressCampaigns.name, count: (0, drizzle_orm_1.sql) `COUNT(${schema_js_1.analyticsEvents.id})` })
                .from(schema_js_1.analyticsEvents)
                .innerJoin(schema_js_1.wordpressCampaigns, (0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.id, schema_js_1.analyticsEvents.campaignId))
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since), (0, drizzle_orm_1.inArray)(schema_js_1.analyticsEvents.campaignId, topCampaignIds)))
                .groupBy(schema_js_1.wordpressCampaigns.id, schema_js_1.wordpressCampaigns.name)
                .orderBy((0, drizzle_orm_1.desc)((0, drizzle_orm_1.sql) `COUNT(${schema_js_1.analyticsEvents.id})`))
                .limit(10)
            : Promise.resolve([]),
    ]);
    const revenue = summarizeRevenue(eventRows);
    return {
        days: windowDays,
        from: since.toISOString(),
        to: new Date().toISOString(),
        events: { total: totalEvents, sent, failed },
        successRate: sent + failed > 0 ? Math.round((sent / (sent + failed)) * 10000) / 100 : null,
        daily: dailyRows.map((row) => ({ day: String(row.day).slice(0, 10), eventName: row.eventName, count: toFiniteInt(row.count) })),
        platforms,
        topPosts: topPosts.map((row) => ({ id: row.id, title: row.title ?? 'پست بدون عنوان', events: toFiniteInt(row.count) })),
        topCampaigns: topCampaigns.map((row) => ({ id: row.id, name: row.name, events: toFiniteInt(row.count) })),
        errors: errorRows.map((row) => ({ eventType: errorKey(row.eventType), count: toFiniteInt(row.count) })),
        links: { clicks: toFiniteInt(linkRows[0]?.clicks) },
        revenue,
        automation,
    };
}
async function getPostAnalytics(tenantId, postId, days = 30) {
    const db = (0, client_js_1.getDb)();
    const since = sinceDate(days);
    const events = await db.select({
        eventType: schema_js_1.analyticsEvents.eventType,
        platform: schema_js_1.analyticsEvents.platform,
        count: (0, drizzle_orm_1.sql) `COUNT(*)`,
        value: (0, drizzle_orm_1.sql) `COALESCE(SUM(${schema_js_1.analyticsEvents.value}), 0)`,
    }).from(schema_js_1.analyticsEvents).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.postId, postId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since))).groupBy(schema_js_1.analyticsEvents.eventType, schema_js_1.analyticsEvents.platform);
    return { days: safeWindow(days), postId, events: events.map((r) => ({ eventType: r.eventType, platform: r.platform, count: toFiniteInt(r.count), value: toFiniteInt(r.value) })) };
}
async function getCampaignAnalytics(tenantId, campaignId, days = 30) {
    const db = (0, client_js_1.getDb)();
    const windowDays = safeWindow(days);
    const since = sinceDate(windowDays);
    const [campaign] = await db.select({ id: schema_js_1.wordpressCampaigns.id, name: schema_js_1.wordpressCampaigns.name, siteId: schema_js_1.wordpressCampaigns.siteId, itemType: schema_js_1.wordpressCampaigns.itemType, isEnabled: schema_js_1.wordpressCampaigns.isEnabled, lastRunAt: schema_js_1.wordpressCampaigns.lastRunAt, lastResultJson: schema_js_1.wordpressCampaigns.lastResultJson })
        .from(schema_js_1.wordpressCampaigns).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.id, campaignId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.tenantId, tenantId))).limit(1);
    if (!campaign)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کمپین'));
    const [events, recent] = await Promise.all([
        db.select({ eventType: schema_js_1.analyticsEvents.eventType, platform: schema_js_1.analyticsEvents.platform, count: (0, drizzle_orm_1.sql) `COUNT(*)`, value: (0, drizzle_orm_1.sql) `COALESCE(SUM(${schema_js_1.analyticsEvents.value}), 0)` })
            .from(schema_js_1.analyticsEvents)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.campaignId, campaignId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since)))
            .groupBy(schema_js_1.analyticsEvents.eventType, schema_js_1.analyticsEvents.platform),
        db.select({
            id: schema_js_1.analyticsEvents.id,
            occurredAt: schema_js_1.analyticsEvents.occurredAt,
            eventType: schema_js_1.analyticsEvents.eventType,
            platform: schema_js_1.analyticsEvents.platform,
            postId: schema_js_1.analyticsEvents.postId,
            targetId: schema_js_1.analyticsEvents.targetId,
            channelId: schema_js_1.analyticsEvents.channelId,
            value: schema_js_1.analyticsEvents.value,
            metadataJson: schema_js_1.analyticsEvents.metadataJson,
            postTitle: schema_js_1.posts.title,
            channelTitle: schema_js_1.channels.title,
            targetState: schema_js_1.postTargets.state,
            attempts: schema_js_1.postTargets.attempts,
            errorCode: schema_js_1.postTargets.errorCode,
            errorMessage: schema_js_1.postTargets.errorMessage,
            sentAt: schema_js_1.postTargets.sentAt,
        })
            .from(schema_js_1.analyticsEvents)
            .leftJoin(schema_js_1.posts, (0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.postId, schema_js_1.posts.id))
            .leftJoin(schema_js_1.channels, (0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.channelId, schema_js_1.channels.id))
            .leftJoin(schema_js_1.postTargets, (0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.targetId, schema_js_1.postTargets.id))
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.campaignId, campaignId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since)))
            .orderBy((0, drizzle_orm_1.desc)(schema_js_1.analyticsEvents.occurredAt))
            .limit(100),
    ]);
    return {
        days: windowDays,
        campaignId,
        campaign: { ...campaign, isEnabled: Boolean(campaign.isEnabled) },
        events: events.map((r) => ({ eventType: r.eventType, platform: r.platform, count: toFiniteInt(r.count), value: toFiniteInt(r.value) })),
        recent: recent.map((r) => ({
            id: r.id,
            occurredAt: r.occurredAt,
            eventType: r.eventType,
            platform: r.platform,
            postId: r.postId,
            postTitle: r.postTitle,
            targetId: r.targetId,
            channelId: r.channelId,
            channelTitle: r.channelTitle,
            targetState: r.targetState,
            attempts: toFiniteInt(r.attempts),
            errorCode: r.errorCode,
            errorMessage: r.errorMessage,
            sentAt: r.sentAt,
            metadata: parseMetadata(r.metadataJson),
        })),
    };
}
async function getWordPressAnalytics(tenantId, days = 30) {
    const db = (0, client_js_1.getDb)();
    const windowDays = safeWindow(days);
    const since = sinceDate(windowDays);
    const types = [
        'wordpress.product.synced', 'wordpress.product.published', 'wordpress.product.failed',
        'wordpress.content.synced', 'wordpress.content.published', 'wordpress.content.failed',
        'wordpress.campaign.run.started', 'wordpress.campaign.run.completed', 'wordpress.campaign.run.failed',
        'wordpress.campaign.items.queued',
    ];
    const [eventRows, siteRows, campaigns, campaignEventRows, deliveryRows] = await Promise.all([
        db.select({ eventType: schema_js_1.analyticsEvents.eventType, value: (0, drizzle_orm_1.sql) `COALESCE(SUM(${schema_js_1.analyticsEvents.value}), 0)`, count: (0, drizzle_orm_1.sql) `COUNT(*)` })
            .from(schema_js_1.analyticsEvents)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since), (0, drizzle_orm_1.inArray)(schema_js_1.analyticsEvents.eventType, types)))
            .groupBy(schema_js_1.analyticsEvents.eventType),
        db.select({ status: schema_js_1.wordpressSites.status, count: (0, drizzle_orm_1.sql) `COUNT(*)` })
            .from(schema_js_1.wordpressSites)
            .where((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.tenantId, tenantId))
            .groupBy(schema_js_1.wordpressSites.status),
        db.select({ id: schema_js_1.wordpressCampaigns.id, name: schema_js_1.wordpressCampaigns.name, enabled: schema_js_1.wordpressCampaigns.isEnabled, lastRunAt: schema_js_1.wordpressCampaigns.lastRunAt })
            .from(schema_js_1.wordpressCampaigns)
            .where((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.tenantId, tenantId))
            .orderBy((0, drizzle_orm_1.desc)(schema_js_1.wordpressCampaigns.updatedAt))
            .limit(50),
        db.select({ campaignId: schema_js_1.analyticsEvents.campaignId, eventType: schema_js_1.analyticsEvents.eventType, value: (0, drizzle_orm_1.sql) `COALESCE(SUM(${schema_js_1.analyticsEvents.value}), 0)` })
            .from(schema_js_1.analyticsEvents)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since), (0, drizzle_orm_1.sql) `${schema_js_1.analyticsEvents.campaignId} IS NOT NULL`, (0, drizzle_orm_1.inArray)(schema_js_1.analyticsEvents.eventType, ['wordpress.campaign.run.completed', 'wordpress.campaign.run.failed', 'wordpress.campaign.items.queued'])))
            .groupBy(schema_js_1.analyticsEvents.campaignId, schema_js_1.analyticsEvents.eventType),
        db.select({ campaignId: schema_js_1.analyticsEvents.campaignId, platform: schema_js_1.analyticsEvents.platform, eventType: schema_js_1.analyticsEvents.eventType, count: (0, drizzle_orm_1.sql) `COUNT(*)` })
            .from(schema_js_1.analyticsEvents)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsEvents.userId, tenantId), (0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since), (0, drizzle_orm_1.sql) `${schema_js_1.analyticsEvents.campaignId} IS NOT NULL`, (0, drizzle_orm_1.inArray)(schema_js_1.analyticsEvents.eventType, ['post.delivery.sent', 'post.delivery.failed'])))
            .groupBy(schema_js_1.analyticsEvents.campaignId, schema_js_1.analyticsEvents.platform, schema_js_1.analyticsEvents.eventType),
    ]);
    const metric = (type) => { const row = eventRows.find((x) => x.eventType === type); return { count: toFiniteInt(row?.count), value: toFiniteInt(row?.value) }; };
    const deliveryMap = new Map();
    const campaignMap = new Map();
    for (const row of deliveryRows) {
        const platform = String(row.platform ?? 'unknown');
        const bucket = deliveryMap.get(platform) ?? { sent: 0, failed: 0 };
        if (row.eventType === 'post.delivery.sent')
            bucket.sent += toFiniteInt(row.count);
        else
            bucket.failed += toFiniteInt(row.count);
        deliveryMap.set(platform, bucket);
        if (row.campaignId) {
            const c = campaignMap.get(row.campaignId) ?? { runs: 0, failedRuns: 0, queued: 0, delivered: 0, failedDelivery: 0 };
            if (row.eventType === 'post.delivery.sent')
                c.delivered += toFiniteInt(row.count);
            else
                c.failedDelivery += toFiniteInt(row.count);
            campaignMap.set(row.campaignId, c);
        }
    }
    for (const row of campaignEventRows) {
        if (!row.campaignId)
            continue;
        const c = campaignMap.get(row.campaignId) ?? { runs: 0, failedRuns: 0, queued: 0, delivered: 0, failedDelivery: 0 };
        if (row.eventType === 'wordpress.campaign.run.completed')
            c.runs += Math.max(1, toFiniteInt(row.value));
        else if (row.eventType === 'wordpress.campaign.run.failed')
            c.failedRuns += Math.max(1, toFiniteInt(row.value));
        else
            c.queued += Math.max(0, toFiniteInt(row.value));
        campaignMap.set(row.campaignId, c);
    }
    return {
        days: windowDays,
        from: since.toISOString(),
        to: new Date().toISOString(),
        sites: { total: siteRows.reduce((n, r) => n + toFiniteInt(r.count), 0), active: toFiniteInt(siteRows.find((r) => r.status === 'ACTIVE')?.count) },
        products: { synced: metric('wordpress.product.synced').value, published: metric('wordpress.product.published').value, failed: metric('wordpress.product.failed').value },
        contents: { synced: metric('wordpress.content.synced').value, published: metric('wordpress.content.published').value, failed: metric('wordpress.content.failed').value },
        campaigns: {
            total: campaigns.length,
            active: campaigns.filter((r) => Boolean(r.enabled)).length,
            runs: metric('wordpress.campaign.run.completed').value,
            failedRuns: metric('wordpress.campaign.run.failed').value,
            queued: metric('wordpress.campaign.items.queued').value,
            items: campaigns.map((r) => ({ id: r.id, name: r.name, enabled: Boolean(r.enabled), lastRunAt: r.lastRunAt, ...(campaignMap.get(r.id) ?? { runs: 0, failedRuns: 0, queued: 0, delivered: 0, failedDelivery: 0 }) })),
        },
        delivery: Object.fromEntries(deliveryMap.entries()),
    };
}
async function getAdminAnalytics(days = 30) {
    const db = (0, client_js_1.getDb)();
    const since = sinceDate(days);
    const [events, users, links, platforms, revenueRows] = await Promise.all([
        db.select({ eventType: schema_js_1.analyticsEvents.eventType, count: (0, drizzle_orm_1.sql) `COUNT(*)` }).from(schema_js_1.analyticsEvents).where((0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since)).groupBy(schema_js_1.analyticsEvents.eventType).orderBy((0, drizzle_orm_1.desc)((0, drizzle_orm_1.sql) `COUNT(*)`)).limit(20),
        db.select({ userId: schema_js_1.analyticsEvents.userId, count: (0, drizzle_orm_1.sql) `COUNT(*)` }).from(schema_js_1.analyticsEvents).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since), (0, drizzle_orm_1.sql) `${schema_js_1.analyticsEvents.userId} IS NOT NULL`)).groupBy(schema_js_1.analyticsEvents.userId).orderBy((0, drizzle_orm_1.desc)((0, drizzle_orm_1.sql) `COUNT(*)`)).limit(20),
        db.select({ clicks: (0, drizzle_orm_1.sql) `COALESCE(SUM(${schema_js_1.analyticsLinks.clickCount}), 0)` }).from(schema_js_1.analyticsLinks),
        db.select({ platform: schema_js_1.analyticsEvents.platform, eventType: schema_js_1.analyticsEvents.eventType, count: (0, drizzle_orm_1.sql) `COUNT(*)` }).from(schema_js_1.analyticsEvents).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since), (0, drizzle_orm_1.inArray)(schema_js_1.analyticsEvents.eventType, ['post.sent', 'post.failed']))).groupBy(schema_js_1.analyticsEvents.platform, schema_js_1.analyticsEvents.eventType),
        db.select({ eventType: schema_js_1.analyticsEvents.eventType, value: schema_js_1.analyticsEvents.value, metadataJson: schema_js_1.analyticsEvents.metadataJson }).from(schema_js_1.analyticsEvents).where((0, drizzle_orm_1.gte)(schema_js_1.analyticsEvents.occurredAt, since)),
    ]);
    const platformSummary = emptyPlatformMap();
    for (const row of platforms) {
        const platform = String(row.platform ?? '');
        if (!(platform in platformSummary))
            continue;
        const key = row.eventType === 'post.sent' ? 'sent' : 'failed';
        const bucket = platformSummary[platform];
        if (bucket)
            bucket[key] = toFiniteInt(row.count);
    }
    const revenue = summarizeRevenue(revenueRows);
    const automation = summarizeAutomationRows(revenueRows);
    return {
        days: safeWindow(days),
        events: events.map((r) => ({ eventType: r.eventType, count: toFiniteInt(r.count) })),
        topUsers: users.map((r) => ({ userId: r.userId, count: toFiniteInt(r.count) })),
        links: { clicks: toFiniteInt(links[0]?.clicks) },
        platforms: platformSummary,
        revenue,
        automation,
    };
}
async function createTrackedLink(input) {
    const url = input.destinationUrl.trim();
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('Unsupported destination protocol');
    const db = (0, client_js_1.getDb)();
    const id = (0, ids_js_1.newId)();
    const token = randomToken();
    await db.insert(schema_js_1.analyticsLinks).values({
        id,
        userId: input.userId,
        postId: input.postId ?? null,
        targetId: input.targetId ?? null,
        channelId: input.channelId ?? null,
        campaignId: input.campaignId ?? null,
        token,
        destinationUrl: url,
        clickCount: 0,
        lastClickedAt: null,
    });
    return { id, token, destinationUrl: url, source: input.source ?? null };
}
async function getLinkStats(userId, id) {
    const db = (0, client_js_1.getDb)();
    const [link] = await db.select().from(schema_js_1.analyticsLinks).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsLinks.id, id), (0, drizzle_orm_1.eq)(schema_js_1.analyticsLinks.userId, userId))).limit(1);
    if (!link)
        return null;
    const rows = await db.select({ day: (0, drizzle_orm_1.sql) `DATE(${schema_js_1.analyticsLinkClicks.clickedAt})`, count: (0, drizzle_orm_1.sql) `COUNT(*)` })
        .from(schema_js_1.analyticsLinkClicks)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.analyticsLinkClicks.linkId, id), (0, drizzle_orm_1.gte)(schema_js_1.analyticsLinkClicks.clickedAt, sinceDate(30))))
        .groupBy((0, drizzle_orm_1.sql) `DATE(${schema_js_1.analyticsLinkClicks.clickedAt})`)
        .orderBy((0, drizzle_orm_1.asc)((0, drizzle_orm_1.sql) `DATE(${schema_js_1.analyticsLinkClicks.clickedAt})`));
    return { ...link, daily: rows.map((r) => ({ day: String(r.day).slice(0, 10), count: toFiniteInt(r.count) })) };
}
async function resolveTrackedLink(token) {
    if (!LINK_TOKEN_PATTERN.test(token))
        return null;
    const db = (0, client_js_1.getDb)();
    const [link] = await db.select().from(schema_js_1.analyticsLinks).where((0, drizzle_orm_1.eq)(schema_js_1.analyticsLinks.token, token)).limit(1);
    return link ?? null;
}
async function recordTrackedLinkClick(link, input) {
    const db = (0, client_js_1.getDb)();
    const clickedAt = new Date();
    await db.transaction(async (tx) => {
        await tx.insert(schema_js_1.analyticsLinkClicks).values({
            id: (0, ids_js_1.newId)(),
            linkId: link.id,
            clickedAt,
            platform: input.platform?.slice(0, 24) ?? null,
            source: input.source?.slice(0, 32) ?? null,
            referrer: input.referrer?.slice(0, 500) ?? null,
            userAgent: input.userAgent?.slice(0, 500) ?? null,
            ipHash: ipHash(input.ip ?? undefined),
            metadataJson: null,
        });
        await tx.update(schema_js_1.analyticsLinks).set({ clickCount: (0, drizzle_orm_1.sql) `${schema_js_1.analyticsLinks.clickCount} + 1`, lastClickedAt: clickedAt }).where((0, drizzle_orm_1.eq)(schema_js_1.analyticsLinks.id, link.id));
    });
    await recordAnalyticsEvent({
        userId: link.userId,
        eventType: 'link.clicked',
        occurredAt: clickedAt,
        postId: link.postId,
        targetId: link.targetId,
        channelId: link.channelId,
        campaignId: link.campaignId,
        linkId: link.id,
        platform: input.platform,
        source: input.source,
        value: 1,
        dedupeKey: null,
    });
}
