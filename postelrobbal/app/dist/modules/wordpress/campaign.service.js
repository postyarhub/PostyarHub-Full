"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listCampaigns = listCampaigns;
exports.upsertCampaign = upsertCampaign;
exports.deleteCampaign = deleteCampaign;
exports.setCampaignEnabled = setCampaignEnabled;
exports.runCampaign = runCampaign;
exports.runDueCampaigns = runDueCampaigns;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const ids_js_1 = require("../../core/ids.js");
const audit_js_1 = require("../../core/audit.js");
const outbox_js_1 = require("../../core/outbox.js");
const analytics_service_js_1 = require("../analytics/analytics.service.js");
const plan_service_js_1 = require("../subscriptions/plan.service.js");
const template_service_js_1 = require("../templates/template.service.js");
const connection_js_1 = require("../../queue/connection.js");
const MAX_CHANNELS = 5;
const MAX_ITEMS = 20;
const ALLOWED_SELECTIONS = new Set([
    'latest',
    'newest',
    'recently_updated',
    'random',
    'manual',
    'category',
    'featured_products',
    'sale_products',
    'in_stock_products',
    'out_of_stock_products',
    'best_selling_products',
]);
const PRODUCT_ONLY_SELECTIONS = new Set([
    'featured_products',
    'sale_products',
    'in_stock_products',
    'out_of_stock_products',
    'best_selling_products',
]);
function validTime(value) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function dayKey(value) {
    return value.trim().toLowerCase();
}
function localParts(date, timeZone) {
    let formatter;
    try {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
        });
    }
    catch {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Tehran',
            hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
        });
    }
    const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`,
        weekday: String(parts.weekday ?? '').slice(0, 3).toLowerCase(),
    };
}
function selectedSlot(campaign, now, timeZone) {
    const current = localParts(now, timeZone);
    if (current.time < campaign.sendTime)
        return false;
    if (campaign.frequency === 'weekly') {
        const days = Array.isArray(campaign.daysJson) ? campaign.daysJson.map(dayKey) : [];
        if (days.length && !days.includes(current.weekday))
            return false;
    }
    if (!campaign.lastRunAt)
        return true;
    const previous = localParts(campaign.lastRunAt, timeZone);
    if (campaign.frequency === 'daily')
        return previous.date !== current.date;
    return !(previous.date === current.date && previous.time >= campaign.sendTime);
}
function discountPercent(regularPrice, salePrice) {
    const regular = Number(regularPrice ?? 0);
    const sale = Number(salePrice ?? 0);
    if (!Number.isFinite(regular) || !Number.isFinite(sale) || regular <= 0 || sale <= 0 || sale >= regular)
        return '';
    return String(Math.max(0, Math.min(100, Math.round(((regular - sale) / regular) * 100))));
}
function moneyFa(value) {
    if (value === null || value === undefined)
        return '';
    return Math.max(0, Math.floor(value)).toLocaleString('fa-IR');
}
function productContext(row, siteUrl, selectionType) {
    const title = row.customTitle?.trim() || row.title;
    const body = row.customBody?.trim() || row.body || row.excerpt || '';
    const image = row.customImageUrl?.trim() || row.imageUrl || '';
    const price = moneyFa(row.priceRial);
    const regularPrice = moneyFa(row.regularPriceRial);
    const salePrice = moneyFa(row.salePriceRial);
    return {
        title,
        description: row.excerpt || body,
        excerpt: row.excerpt || '',
        content: body,
        link: row.permalink || siteUrl,
        date: row.lastSyncedAt ? row.lastSyncedAt.toLocaleDateString('fa-IR') : '',
        author: '',
        site_name: (() => { try {
            return new URL(siteUrl).hostname;
        }
        catch {
            return siteUrl;
        } })(),
        post_type: 'محصول',
        featured_image: image,
        site_url: siteUrl,
        event_type: selectionType,
        product_id: row.wcProductId,
        discount_percent: discountPercent(row.regularPriceRial, row.salePriceRial),
        old_price: moneyFa(row.oldPriceRial),
        price,
        regular_price: regularPrice,
        sale_price: salePrice,
        sku: row.sku || '',
        stock_status: row.stockStatus === 'instock' ? 'موجود' : row.stockStatus === 'outofstock' ? 'ناموجود' : row.stockStatus || '',
    };
}
function contentContext(row, siteUrl, selectionType) {
    const title = row.customTitle?.trim() || row.title;
    const body = row.customBody?.trim() || row.body;
    const image = row.customImageUrl?.trim() || row.imageUrl || '';
    let siteName = siteUrl;
    try {
        siteName = new URL(siteUrl).hostname;
    }
    catch { /* preserve URL text */ }
    return {
        title,
        description: body,
        excerpt: body,
        content: body,
        link: row.permalink || siteUrl,
        date: row.createdAt?.toLocaleDateString('fa-IR') || '',
        author: '',
        site_name: siteName,
        post_type: 'محتوا',
        featured_image: image,
        site_url: siteUrl,
        event_type: selectionType,
        product_id: '',
        discount_percent: '',
        old_price: '', price: '', regular_price: '', sale_price: '', sku: '', stock_status: '',
    };
}
async function assertCampaignAccess(tenantId) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'woocommerce');
    await (0, plan_service_js_1.assertFeature)(tenantId, 'wordpress_campaigns');
}
async function requireSite(tenantId, siteId) {
    await assertCampaignAccess(tenantId);
    const db = (0, client_js_1.getDb)();
    const [site] = await db.select().from(schema_js_1.wordpressSites).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.id, siteId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.tenantId, tenantId))).limit(1);
    if (!site)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('سایت'));
    if (site.status !== 'ACTIVE')
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('سایت وردپرسی هنوز فعال نشده است.'));
    return site;
}
async function resolveChannels(tenantId, site, requested) {
    const candidates = (requested?.length ? requested : (site.channelIdsJson ?? [])).slice(0, MAX_CHANNELS);
    const db = (0, client_js_1.getDb)();
    let rows = candidates.length
        ? await db.select({ id: schema_js_1.channels.id }).from(schema_js_1.channels).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE'), (0, drizzle_orm_1.sql) `${schema_js_1.channels.id} in (${drizzle_orm_1.sql.join(candidates.map((id) => (0, drizzle_orm_1.sql) `${id}`), (0, drizzle_orm_1.sql) `, `)})`))
        : [];
    if (!rows.length) {
        rows = await db.select({ id: schema_js_1.channels.id }).from(schema_js_1.channels).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE'))).orderBy((0, drizzle_orm_1.asc)(schema_js_1.channels.createdAt)).limit(MAX_CHANNELS);
    }
    const ids = rows.map((r) => r.id);
    if (!ids.length)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('کانال فعالی برای اجرای کمپین یافت نشد.'));
    return ids;
}
function normalizeInput(input) {
    const name = input.name.trim();
    if (!name)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('نام کمپین الزامی است.'));
    if (!validTime(input.sendTime))
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ساعت کمپین معتبر نیست.'));
    if (!ALLOWED_SELECTIONS.has(input.selectionType))
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('نوع انتخاب کمپین معتبر نیست.'));
    if (input.itemType === 'content' && PRODUCT_ONLY_SELECTIONS.has(input.selectionType)) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('این معیار انتخاب فقط برای محصولات ووکامرس قابل استفاده است.'));
    }
    const days = Array.from(new Set((input.days ?? []).map(dayKey).filter((x) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].includes(x))));
    if (input.frequency === 'weekly' && !days.length)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای کمپین هفتگی حداقل یک روز انتخاب کنید.'));
    const selectionIds = Array.from(new Set((input.selectionIds ?? []).map((x) => Number(x)).filter(Number.isFinite))).slice(0, MAX_ITEMS);
    if ((input.selectionType === 'manual' || input.selectionType === 'category') && selectionIds.length === 0)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(input.selectionType === 'category' ? 'برای انتخاب دسته‌بندی، حداقل یک دسته را انتخاب کنید.' : 'برای انتخاب دستی حداقل یک مورد را انتخاب کنید.'));
    return {
        name: name.slice(0, 120),
        siteId: input.siteId,
        itemType: input.itemType,
        selectionType: input.selectionType === 'newest' ? 'latest' : input.selectionType,
        selectionIds: selectionIds.length ? selectionIds : null,
        templateId: input.templateId?.trim() || null,
        channelIds: Array.from(new Set(input.channelIds ?? [])).slice(0, MAX_CHANNELS),
        frequency: input.frequency,
        sendTime: input.sendTime,
        days: days.length ? days : ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
        itemCount: Math.max(1, Math.min(MAX_ITEMS, Math.floor(input.itemCount))),
        isEnabled: Boolean(input.isEnabled),
    };
}
async function listCampaigns(tenantId) {
    await assertCampaignAccess(tenantId);
    const db = (0, client_js_1.getDb)();
    return db.select().from(schema_js_1.wordpressCampaigns).where((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.tenantId, tenantId)).orderBy((0, drizzle_orm_1.desc)(schema_js_1.wordpressCampaigns.createdAt));
}
async function upsertCampaign(tenantId, input, id) {
    const normalized = normalizeInput(input);
    const site = await requireSite(tenantId, normalized.siteId);
    const channelIds = await resolveChannels(tenantId, site, normalized.channelIds);
    const db = (0, client_js_1.getDb)();
    if (normalized.templateId) {
        const [template] = await db.select({ id: schema_js_1.messageTemplates.id }).from(schema_js_1.messageTemplates).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.messageTemplates.id, normalized.templateId), (0, drizzle_orm_1.eq)(schema_js_1.messageTemplates.tenantId, tenantId))).limit(1);
        if (!template)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('قالب'));
    }
    if (id) {
        const [existing] = await db.select().from(schema_js_1.wordpressCampaigns).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.id, id), (0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.tenantId, tenantId))).limit(1);
        if (!existing)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کمپین'));
        await db.update(schema_js_1.wordpressCampaigns).set({
            name: normalized.name,
            siteId: site.id,
            itemType: normalized.itemType,
            selectionType: normalized.selectionType,
            selectionIdsJson: normalized.selectionIds,
            templateId: normalized.templateId,
            channelIdsJson: channelIds,
            frequency: normalized.frequency,
            sendTime: normalized.sendTime,
            daysJson: normalized.days,
            itemCount: normalized.itemCount,
            isEnabled: normalized.isEnabled ? 1 : 0,
        }).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.id, id), (0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.tenantId, tenantId)));
        await (0, audit_js_1.audit)({ action: 'wordpress.campaign_updated', actorId: tenantId, subjectType: 'wordpress_campaign', subjectId: id });
        return id;
    }
    const campaignId = (0, ids_js_1.newId)();
    try {
        await db.insert(schema_js_1.wordpressCampaigns).values({
            id: campaignId,
            tenantId,
            siteId: site.id,
            name: normalized.name,
            itemType: normalized.itemType,
            selectionType: normalized.selectionType,
            selectionIdsJson: normalized.selectionIds,
            templateId: normalized.templateId,
            channelIdsJson: channelIds,
            frequency: normalized.frequency,
            sendTime: normalized.sendTime,
            daysJson: normalized.days,
            itemCount: normalized.itemCount,
            isEnabled: normalized.isEnabled ? 1 : 0,
            sentIdsJson: [],
            lastRunAt: null,
            lastResultJson: null,
        });
    }
    catch (err) {
        const e = err;
        if (e?.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(String(e?.message ?? ''))) {
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('کمپینی با این نام قبلاً ثبت شده است.'));
        }
        throw err;
    }
    await (0, audit_js_1.audit)({ action: 'wordpress.campaign_created', actorId: tenantId, subjectType: 'wordpress_campaign', subjectId: campaignId });
    return campaignId;
}
async function deleteCampaign(tenantId, id) {
    await assertCampaignAccess(tenantId);
    const db = (0, client_js_1.getDb)();
    const result = await db.delete(schema_js_1.wordpressCampaigns).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.id, id), (0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.tenantId, tenantId)));
    const affected = Array.isArray(result) ? Number(result[0]?.affectedRows ?? 0) : Number(result?.affectedRows ?? 0);
    if (affected === 0)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کمپین'));
    await (0, audit_js_1.audit)({ action: 'wordpress.campaign_deleted', actorId: tenantId, subjectType: 'wordpress_campaign', subjectId: id });
}
async function setCampaignEnabled(tenantId, id, enabled) {
    await assertCampaignAccess(tenantId);
    const db = (0, client_js_1.getDb)();
    const result = await db.update(schema_js_1.wordpressCampaigns).set({ isEnabled: enabled ? 1 : 0 }).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.id, id), (0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.tenantId, tenantId)));
    const affected = Array.isArray(result) ? Number(result[0]?.affectedRows ?? 0) : Number(result?.affectedRows ?? 0);
    if (affected === 0)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کمپین'));
}
async function selectItems(tx, campaign) {
    const sent = Array.isArray(campaign.sentIdsJson) ? campaign.sentIdsJson.map((x) => Number(x)).filter(Number.isFinite) : [];
    const limit = Math.min(MAX_ITEMS, Math.max(1, campaign.itemCount));
    if (campaign.itemType === 'product') {
        const conditions = [(0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.siteId, campaign.siteId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.tenantId, campaign.tenantId)];
        const manualIds = Array.isArray(campaign.selectionIdsJson) ? campaign.selectionIdsJson.map((x) => Number(x)).filter(Number.isFinite) : [];
        if (campaign.selectionType === 'manual') {
            if (!manualIds.length)
                return [];
            conditions.push((0, drizzle_orm_1.inArray)(schema_js_1.wordpressProducts.wcProductId, manualIds));
        }
        else if (campaign.selectionType === 'category') {
            if (!manualIds.length)
                return [];
            conditions.push((0, drizzle_orm_1.sql) `(${drizzle_orm_1.sql.join(manualIds.map((categoryId) => (0, drizzle_orm_1.sql) `JSON_CONTAINS(${schema_js_1.wordpressProducts.categoriesJson}, JSON_OBJECT('id', ${categoryId}), '$') = 1`), (0, drizzle_orm_1.sql) ` OR `)})`);
        }
        switch (campaign.selectionType) {
            case 'featured_products':
                conditions.push((0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.isFeatured, 1));
                break;
            case 'sale_products':
                conditions.push((0, drizzle_orm_1.isNotNull)(schema_js_1.wordpressProducts.salePriceRial));
                break;
            case 'in_stock_products':
                conditions.push((0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.stockStatus, 'instock'));
                break;
            case 'out_of_stock_products':
                conditions.push((0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.stockStatus, 'outofstock'));
                break;
        }
        const shouldExclude = campaign.selectionType !== 'latest' && campaign.selectionType !== 'manual';
        if (shouldExclude && sent.length)
            conditions.push((0, drizzle_orm_1.notInArray)(schema_js_1.wordpressProducts.wcProductId, sent));
        const base = tx.select().from(schema_js_1.wordpressProducts).where((0, drizzle_orm_1.and)(...conditions));
        if (campaign.selectionType === 'random')
            return base.orderBy((0, drizzle_orm_1.sql) `RAND()`).limit(limit);
        if (campaign.selectionType === 'best_selling_products')
            return base.orderBy((0, drizzle_orm_1.desc)(schema_js_1.wordpressProducts.salesCount), (0, drizzle_orm_1.desc)(schema_js_1.wordpressProducts.lastSyncedAt)).limit(limit);
        return base.orderBy((0, drizzle_orm_1.desc)(schema_js_1.wordpressProducts.lastSyncedAt), (0, drizzle_orm_1.asc)(schema_js_1.wordpressProducts.id)).limit(limit);
    }
    const conditions = [(0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.siteId, campaign.siteId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.tenantId, campaign.tenantId)];
    const manualIds = Array.isArray(campaign.selectionIdsJson) ? campaign.selectionIdsJson.map((x) => Number(x)).filter(Number.isFinite) : [];
    if (campaign.selectionType === 'manual') {
        if (!manualIds.length)
            return [];
        conditions.push((0, drizzle_orm_1.inArray)(schema_js_1.wordpressContents.contentId, manualIds));
    }
    else if (campaign.selectionType === 'category') {
        if (!manualIds.length)
            return [];
        conditions.push((0, drizzle_orm_1.sql) `(${drizzle_orm_1.sql.join(manualIds.map((categoryId) => (0, drizzle_orm_1.sql) `JSON_CONTAINS(${schema_js_1.wordpressContents.categoriesJson}, JSON_OBJECT('id', ${categoryId}), '$') = 1`), (0, drizzle_orm_1.sql) ` OR `)})`);
    }
    if (campaign.selectionType !== 'latest' && campaign.selectionType !== 'manual' && sent.length)
        conditions.push((0, drizzle_orm_1.notInArray)(schema_js_1.wordpressContents.contentId, sent));
    const base = tx.select().from(schema_js_1.wordpressContents).where((0, drizzle_orm_1.and)(...conditions));
    if (campaign.selectionType === 'random')
        return base.orderBy((0, drizzle_orm_1.sql) `RAND()`).limit(limit);
    return base.orderBy((0, drizzle_orm_1.desc)(schema_js_1.wordpressContents.createdAt), (0, drizzle_orm_1.asc)(schema_js_1.wordpressContents.id)).limit(limit);
}
async function runCampaign(tenantId, id, force = false) {
    await assertCampaignAccess(tenantId);
    const db = (0, client_js_1.getDb)();
    let result = { queued: 0, items: 0, channels: 0, skipped: 0 };
    await (0, analytics_service_js_1.recordAnalyticsEvent)({ userId: tenantId, eventType: 'wordpress.campaign.run.started', campaignId: id, source: 'campaign', metadata: { force } });
    try {
        await db.transaction(async (tx) => {
            const [campaign] = await tx.select().from(schema_js_1.wordpressCampaigns).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.id, id), (0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.tenantId, tenantId))).limit(1).for('update');
            if (!campaign)
                throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کمپین'));
            if (!force && !campaign.isEnabled)
                throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('کمپین غیرفعال است.'));
            // The outer scheduler eligibility check runs outside this row lock. Two
            // scheduler invocations can therefore both observe the same stale
            // lastRunAt. Re-evaluate the slot after locking the campaign row so only
            // the first transaction for a scheduled slot can publish items.
            if (!force) {
                const [owner] = await tx.select({ timezone: schema_js_1.users.timezone }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, tenantId)).limit(1);
                const lockedNow = new Date();
                if (!selectedSlot(campaign, lockedNow, owner?.timezone || 'Asia/Tehran'))
                    return;
            }
            const [site] = await tx.select().from(schema_js_1.wordpressSites).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.id, campaign.siteId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.status, 'ACTIVE'))).limit(1);
            if (!site)
                throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('سایت وردپرسی کمپین فعال نیست.'));
            const channelIds = (campaign.channelIdsJson ?? []).slice(0, MAX_CHANNELS);
            const activeChannels = await tx.select({ id: schema_js_1.channels.id }).from(schema_js_1.channels).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE'), channelIds.length ? (0, drizzle_orm_1.inArray)(schema_js_1.channels.id, channelIds) : (0, drizzle_orm_1.sql) `1=1`)).limit(MAX_CHANNELS);
            if (!activeChannels.length)
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('کانال فعالی برای اجرای کمپین یافت نشد.'));
            let templateBody = '{title}\n\n{description}\n\n🔗 {link}';
            if (campaign.templateId) {
                const [template] = await tx.select({ body: schema_js_1.messageTemplates.body }).from(schema_js_1.messageTemplates).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.messageTemplates.id, campaign.templateId), (0, drizzle_orm_1.eq)(schema_js_1.messageTemplates.tenantId, tenantId))).limit(1);
                if (!template)
                    throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('قالب'));
                templateBody = template.body;
            }
            // Match the quota serialization boundary used by ordinary publishing.
            // A campaign may generate many posts in one transaction, so checking once
            // per item outside this transaction would allow the limit to be exceeded.
            await tx.select({ id: schema_js_1.users.id }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, tenantId)).limit(1).for('update');
            const planContext = await (0, plan_service_js_1.getPlanContext)(tenantId);
            let availablePostSlots = Number.POSITIVE_INFINITY;
            if (planContext.limits.max_posts > 0) {
                const postConditions = [
                    (0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, tenantId),
                    (0, drizzle_orm_1.ne)(schema_js_1.posts.state, 'DRAFT'),
                    (0, drizzle_orm_1.ne)(schema_js_1.posts.state, 'CANCELLED'),
                    ...(planContext.startedAt ? [(0, drizzle_orm_1.gte)(schema_js_1.posts.createdAt, planContext.startedAt)] : []),
                ];
                const [usedRow] = await tx.select({ total: (0, drizzle_orm_1.count)() }).from(schema_js_1.posts).where((0, drizzle_orm_1.and)(...postConditions));
                availablePostSlots = Math.max(0, planContext.limits.max_posts - Number(usedRow?.total ?? 0));
            }
            const items = await selectItems(tx, campaign);
            if (items.length > availablePostSlots) {
                throw new errors_js_1.AppError(errors_js_1.ERR.QUOTA_EXCEEDED('ارسال پست'));
            }
            const sentIds = Array.isArray(campaign.sentIdsJson) ? campaign.sentIdsJson.map((x) => Number(x)).filter(Number.isFinite) : [];
            const sentSet = new Set(sentIds);
            let queued = 0;
            let skipped = 0;
            let processedItems = 0;
            for (const item of items) {
                const itemId = campaign.itemType === 'product'
                    ? Number(item.wcProductId)
                    : Number(item.contentId);
                if (!Number.isFinite(itemId))
                    continue;
                const context = campaign.itemType === 'product'
                    ? productContext(item, site.siteUrl, campaign.selectionType)
                    : contentContext(item, site.siteUrl, campaign.selectionType);
                const body = (0, template_service_js_1.renderTemplate)(templateBody, context).trim();
                if (!body) {
                    skipped++;
                    continue;
                }
                if (body.length > 4000) {
                    throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('متن خروجی کمپین پس از جای‌گذاری قالب نباید از ۴۰۰۰ نویسه بیشتر باشد.'));
                }
                // Every campaign item gets the same durable post/target state machine as
                // normal publishing. The outbox carries the WordPress-specific rendered
                // body/image, while post_targets remains the authoritative delivery state.
                const postId = (0, ids_js_1.newId)();
                await tx.insert(schema_js_1.posts).values({
                    id: postId,
                    tenantId,
                    title: String(context.title ?? '').slice(0, 190) || null,
                    body,
                    source: 'WORDPRESS',
                    state: 'QUEUED',
                });
                for (const ch of activeChannels) {
                    const targetId = (0, ids_js_1.newId)();
                    await tx.insert(schema_js_1.postTargets).values({
                        id: targetId,
                        postId,
                        tenantId,
                        channelId: ch.id,
                        state: 'PENDING',
                    });
                    const row = (0, outbox_js_1.outboxRow)({
                        aggregateType: 'wordpress',
                        aggregateId: site.id,
                        eventType: 'wordpress.publish',
                        payload: {
                            tenantId,
                            siteId: site.id,
                            itemType: campaign.itemType,
                            itemId,
                            productId: campaign.itemType === 'product' ? itemId : undefined,
                            contentId: campaign.itemType === 'content' ? itemId : undefined,
                            channelId: ch.id,
                            targetId,
                            postId,
                            title: String(context.title ?? '').slice(0, 190),
                            body,
                            imageUrl: String(context.featured_image ?? '') || null,
                            campaignId: campaign.id,
                        },
                    });
                    await tx.insert(schema_js_1.outboxEvents).values(row);
                    queued++;
                }
                processedItems++;
                // sentIdsJson is updated only by the delivery worker after a provider
                // confirms at least one successful send. Queueing is not a successful send.
            }
            result = { queued, items: processedItems, channels: activeChannels.length, skipped };
            await tx.update(schema_js_1.wordpressCampaigns).set({
                lastRunAt: new Date(),
                // Keep only confirmed sent ids here; queued items are intentionally not
                // added until delivery succeeds.
                sentIdsJson: Array.from(sentSet).slice(-5000),
                lastResultJson: { ...result, finishedAt: new Date().toISOString() },
            }).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.id, campaign.id), (0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.tenantId, tenantId)));
        });
    }
    catch (error) {
        await (0, analytics_service_js_1.recordAnalyticsEvent)({ userId: tenantId, eventType: 'wordpress.campaign.run.failed', campaignId: id, source: 'campaign', metadata: { error: error instanceof Error ? error.message : String(error).slice(0, 500) } });
        throw error;
    }
    await (0, analytics_service_js_1.recordAnalyticsEvent)({ userId: tenantId, eventType: 'wordpress.campaign.items.queued', campaignId: id, source: 'campaign', value: result.queued, metadata: result });
    await (0, analytics_service_js_1.recordAnalyticsEvent)({ userId: tenantId, eventType: 'wordpress.campaign.run.completed', campaignId: id, source: 'campaign', metadata: result });
    await (0, audit_js_1.audit)({ action: 'wordpress.campaign_run', actorId: tenantId, subjectType: 'wordpress_campaign', subjectId: id, meta: result });
    return result;
}
async function runDueCampaigns() {
    const db = (0, client_js_1.getDb)();
    const now = new Date();
    // Rotate through stable ULID-ordered pages. A fixed first-page LIMIT lets
    // the first 100 campaigns starve every campaign created after them forever.
    const redis = (0, connection_js_1.getRedis)();
    const cursorKey = 'postyar:campaign:scheduler-cursor';
    const cursor = await redis.get(cursorKey).catch(() => null);
    let campaigns = await db.select().from(schema_js_1.wordpressCampaigns)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.isEnabled, 1), ...(cursor ? [(0, drizzle_orm_1.sql) `${schema_js_1.wordpressCampaigns.id} > ${cursor}`] : [])))
        .orderBy((0, drizzle_orm_1.asc)(schema_js_1.wordpressCampaigns.id))
        .limit(100);
    if (campaigns.length === 0 && cursor) {
        campaigns = await db.select().from(schema_js_1.wordpressCampaigns)
            .where((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.isEnabled, 1))
            .orderBy((0, drizzle_orm_1.asc)(schema_js_1.wordpressCampaigns.id))
            .limit(100);
    }
    if (campaigns.length > 0) {
        await redis.set(cursorKey, campaigns[campaigns.length - 1].id).catch(() => undefined);
    }
    let ran = 0;
    for (const campaign of campaigns) {
        const [user] = await db.select({ timezone: schema_js_1.users.timezone }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, campaign.tenantId)).limit(1);
        const timeZone = user?.timezone || 'Asia/Tehran';
        if (!selectedSlot(campaign, now, timeZone))
            continue;
        try {
            await runCampaign(campaign.tenantId, campaign.id, false);
            ran++;
        }
        catch {
            // One broken campaign must not block the remaining schedule lane.
        }
    }
    return ran;
}
