"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectSite = connectSite;
exports.listSites = listSites;
exports.updateSiteSettings = updateSiteSettings;
exports.previewFeaturedImage = previewFeaturedImage;
exports.importFeaturedImageToMedia = importFeaturedImageToMedia;
exports.getSiteSettings = getSiteSettings;
exports.deleteSite = deleteSite;
exports.rotateSecret = rotateSecret;
exports.verifySiteRequest = verifySiteRequest;
exports.syncProducts = syncProducts;
exports.publishProduct = publishProduct;
exports.manualSendProducts = manualSendProducts;
exports.syncContents = syncContents;
exports.publishContent = publishContent;
exports.listProductCategories = listProductCategories;
exports.listContentCategories = listContentCategories;
exports.listContents = listContents;
exports.listProducts = listProducts;
const node_crypto_1 = require("node:crypto");
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const http_js_1 = require("../../core/http.js");
const media_service_js_1 = require("../media/media.service.js");
const ids_js_1 = require("../../core/ids.js");
const events_js_1 = require("../../core/events.js");
const outbox_js_1 = require("../../core/outbox.js");
const audit_js_1 = require("../../core/audit.js");
const plan_service_js_1 = require("../subscriptions/plan.service.js");
const analytics_service_js_1 = require("../analytics/analytics.service.js");
const post_service_js_1 = require("../publishing/post.service.js");
const template_service_js_1 = require("../templates/template.service.js");
const MAX_PRODUCTS_PER_SYNC = 200;
const MAX_PUBLISH_CHANNELS = 5;
function normalizeProductEventType(value) {
    if (value === 'price' || value === 'product_price')
        return 'product_price';
    if (value === 'stock' || value === 'product_stock')
        return 'product_stock';
    if (value === 'update')
        return 'update';
    return 'new';
}
function normalizeSiteUrl(raw) {
    let url = raw.trim();
    if (!/^https?:\/\//i.test(url))
        url = `https://${url}`;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('آدرس سایت معتبر نیست.'));
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('فقط آدرس‌های http و https مجاز هستند.'));
    }
    const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
    return normalized.slice(0, 255);
}
function generateHex32() {
    return (0, node_crypto_1.randomBytes)(16).toString('hex'); // 32 hex chars
}
/** Connect a WooCommerce site (plan feature `woocommerce` required, §150). */
async function connectSite(tenantId, rawSiteUrl) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'woocommerce');
    const siteUrl = normalizeSiteUrl(rawSiteUrl);
    const db = (0, client_js_1.getDb)();
    const siteKey = generateHex32();
    const secret = generateHex32();
    const secretHash = await (0, ids_js_1.sha256Hex)(secret);
    const id = (0, ids_js_1.newId)();
    // One site per (tenant, url): reconnecting rotates the secret atomically.
    await db
        .insert(schema_js_1.wordpressSites)
        .values({ id, tenantId, siteUrl, siteKey, secretHash, status: 'ACTIVE' })
        .onDuplicateKeyUpdate({ set: { siteKey, secretHash, status: 'ACTIVE', lastError: null } });
    const [row] = await db
        .select({ id: schema_js_1.wordpressSites.id, siteUrl: schema_js_1.wordpressSites.siteUrl, siteKey: schema_js_1.wordpressSites.siteKey })
        .from(schema_js_1.wordpressSites)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.siteUrl, siteUrl)))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    await (0, audit_js_1.audit)({ action: 'wordpress.connected', actorId: tenantId, subjectType: 'wordpress_site', subjectId: row.id, meta: { siteUrl } });
    await (0, events_js_1.emitEvent)({ name: 'wordpress.connected', tenantId, subjectType: 'wordpress_site', subjectId: row.id, props: { siteUrl } });
    return { id: row.id, siteUrl: row.siteUrl, siteKey: row.siteKey, secret };
}
async function listSites(tenantId) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'woocommerce');
    const db = (0, client_js_1.getDb)();
    const rows = await db
        .select({
        id: schema_js_1.wordpressSites.id,
        siteUrl: schema_js_1.wordpressSites.siteUrl,
        siteKey: schema_js_1.wordpressSites.siteKey,
        status: schema_js_1.wordpressSites.status,
        autoPublish: schema_js_1.wordpressSites.autoPublish,
        sendImage: schema_js_1.wordpressSites.sendImage,
        channelIdsJson: schema_js_1.wordpressSites.channelIdsJson,
        automationJson: schema_js_1.wordpressSites.automationJson,
        messageStyle: schema_js_1.wordpressSites.messageStyle,
        lastError: schema_js_1.wordpressSites.lastError,
        lastSyncAt: schema_js_1.wordpressSites.lastSyncAt,
        createdAt: schema_js_1.wordpressSites.createdAt,
    })
        .from(schema_js_1.wordpressSites)
        .where((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.tenantId, tenantId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.wordpressSites.createdAt));
    return rows;
}
async function updateSiteSettings(tenantId, siteId, input) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'woocommerce');
    const db = (0, client_js_1.getDb)();
    await db
        .update(schema_js_1.wordpressSites)
        .set({ ...(input.autoPublish === undefined ? {} : { autoPublish: input.autoPublish ? 1 : 0 }), ...(input.sendImage === undefined ? {} : { sendImage: input.sendImage ? 1 : 0 }), ...(input.channelIds === undefined ? {} : { channelIdsJson: input.channelIds }), ...(input.automation === undefined ? {} : { automationJson: input.automation }), ...(input.messageStyle === undefined ? {} : { messageStyle: input.messageStyle }) })
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.id, siteId)));
    const [site] = await db
        .select({ id: schema_js_1.wordpressSites.id, autoPublish: schema_js_1.wordpressSites.autoPublish, sendImage: schema_js_1.wordpressSites.sendImage, channelIdsJson: schema_js_1.wordpressSites.channelIdsJson, automationJson: schema_js_1.wordpressSites.automationJson, messageStyle: schema_js_1.wordpressSites.messageStyle })
        .from(schema_js_1.wordpressSites)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.id, siteId)))
        .limit(1);
    if (!site)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('سایت'));
    return site;
}
async function ownedSite(tenantId, siteId) {
    const db = (0, client_js_1.getDb)();
    const [site] = await db
        .select()
        .from(schema_js_1.wordpressSites)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.id, siteId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.tenantId, tenantId)))
        .limit(1);
    if (!site)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('سایت'));
    return site;
}
function normalizeFeaturedImageUrl(raw, siteUrl) {
    let parsed;
    try {
        parsed = new URL(raw.trim(), `${siteUrl.replace(/\/+$/, '')}/`);
    }
    catch {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('نشانی تصویر شاخص معتبر نیست.'));
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('نشانی تصویر باید از نوع HTTP یا HTTPS باشد.'));
    }
    try {
        const base = new URL(siteUrl);
        if (base.protocol === 'https:' && parsed.protocol === 'http:' && parsed.hostname.toLowerCase() === base.hostname.toLowerCase()) {
            parsed.protocol = 'https:';
        }
    }
    catch { /* owned site URL has already passed connection validation */ }
    return parsed.toString();
}
async function fetchFeaturedImageAsset(tenantId, input) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'woocommerce');
    if (!Number.isSafeInteger(input.sourceId) || input.sourceId < 1) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('شناسهٔ محتوا معتبر نیست.'));
    }
    const site = await ownedSite(tenantId, input.siteId);
    const db = (0, client_js_1.getDb)();
    const source = input.itemType === 'product'
        ? (await db.select({ imageUrl: schema_js_1.wordpressProducts.imageUrl, customImageUrl: schema_js_1.wordpressProducts.customImageUrl })
            .from(schema_js_1.wordpressProducts)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.siteId, site.id), (0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.wcProductId, input.sourceId)))
            .limit(1))[0]
        : (await db.select({ imageUrl: schema_js_1.wordpressContents.imageUrl, customImageUrl: schema_js_1.wordpressContents.customImageUrl })
            .from(schema_js_1.wordpressContents)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.siteId, site.id), (0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.contentId, input.sourceId)))
            .limit(1))[0];
    if (!source)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('محتوای وب‌سایت'));
    const imageUrl = String(source.customImageUrl ?? '').trim() || String(source.imageUrl ?? '').trim();
    if (!imageUrl)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای این مورد تصویر شاخص ثبت نشده است.'));
    const url = normalizeFeaturedImageUrl(imageUrl, site.siteUrl);
    let response;
    try {
        response = await (0, http_js_1.httpBuffer)(url, {
            timeoutMs: 25_000,
            ssrfGuard: true,
            headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8' },
        });
    }
    catch {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('دریافت تصویر شاخص از وب‌سایت ناموفق بود. آدرس تصویر را در وردپرس بررسی کنید.'));
    }
    if (response.status !== 200 || response.body.length === 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('تصویر شاخص از وب‌سایت دریافت نشد؛ نشانی یا دسترسی تصویر را بررسی کنید.'));
    }
    let mimeType = response.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (mimeType === 'image/jpg' || mimeType === 'image/pjpeg')
        mimeType = 'image/jpeg';
    if (mimeType === 'image/x-png')
        mimeType = 'image/png';
    if (!(0, media_service_js_1.isAllowedImageMime)(mimeType)) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('نشانی انتخاب‌شده به یک تصویر پشتیبانی‌شده اشاره نمی‌کند.'));
    }
    return { buffer: response.body, mimeType };
}
/** Preview through the authenticated application origin. This avoids broken
 * mixed-content/hotlink images in the browser while deriving the URL only from
 * a tenant-owned catalog record and applying the SSRF-safe binary fetcher. */
async function previewFeaturedImage(tenantId, input) {
    return fetchFeaturedImageAsset(tenantId, input);
}
/** Import the actual catalog featured image as private, tenant-owned media. The
 * browser submits only source identifiers; image URLs always come from the
 * tenant-scoped database record, and httpBuffer applies SSRF/redirect guards. */
async function importFeaturedImageToMedia(tenantId, input) {
    const asset = await fetchFeaturedImageAsset(tenantId, input);
    const storedMedia = await (0, media_service_js_1.uploadMedia)(tenantId, { buffer: asset.buffer, mimeType: asset.mimeType, maxBytes: 8 * 1024 * 1024 });
    return { media: storedMedia };
}
async function getSiteSettings(site) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db.select({ autoPublish: schema_js_1.wordpressSites.autoPublish, sendImage: schema_js_1.wordpressSites.sendImage, channelIds: schema_js_1.wordpressSites.channelIdsJson, automation: schema_js_1.wordpressSites.automationJson, messageStyle: schema_js_1.wordpressSites.messageStyle })
        .from(schema_js_1.wordpressSites)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.id, site.id), (0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.tenantId, site.tenantId)))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('سایت'));
    // WordPress plugin 1.9.x renders its available-channel cards from `channels`.
    // Return only channels belonging to this tenant and currently active; never
    // expose bot credentials or the secret fields from the channels/bots tables.
    const activeChannels = await db.select({
        id: schema_js_1.channels.id,
        title: schema_js_1.channels.title,
        channelRef: schema_js_1.channels.channelRef,
        platform: schema_js_1.channels.platform,
    }).from(schema_js_1.channels)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, site.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE')))
        .orderBy((0, drizzle_orm_1.asc)(schema_js_1.channels.createdAt))
        .limit(100);
    const savedChannelIds = Array.isArray(row.channelIds) ? row.channelIds : [];
    // The empty selection already means "use active defaults" in delivery logic.
    // Mirror that same behavior in the plugin UI so these channels are visible
    // and preselected on a fresh connection instead of appearing unconfigured.
    const channelIds = savedChannelIds.length
        ? savedChannelIds.filter((id) => activeChannels.some((channel) => channel.id === id)).slice(0, MAX_PUBLISH_CHANNELS)
        : activeChannels.slice(0, MAX_PUBLISH_CHANNELS).map((channel) => channel.id);
    return {
        autoPublish: Boolean(row.autoPublish),
        channelIds,
        channels: activeChannels,
        automation: row.automation ?? {},
        messageStyle: row.messageStyle,
        sendImage: Boolean(row.sendImage),
    };
}
async function deleteSite(tenantId, siteId) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'woocommerce');
    const site = await ownedSite(tenantId, siteId);
    const db = (0, client_js_1.getDb)();
    await db.transaction(async (tx) => {
        await tx.delete(schema_js_1.wordpressProducts).where((0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.siteId, site.id));
        await tx.delete(schema_js_1.wordpressContents).where((0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.siteId, site.id));
        await tx.delete(schema_js_1.wordpressCampaigns).where((0, drizzle_orm_1.eq)(schema_js_1.wordpressCampaigns.siteId, site.id));
        await tx.delete(schema_js_1.wordpressSites).where((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.id, site.id));
    });
    await (0, audit_js_1.audit)({ action: 'wordpress.disconnected', actorId: tenantId, subjectType: 'wordpress_site', subjectId: site.id, meta: { siteUrl: site.siteUrl } });
}
/** Secret rotation: new plaintext returned ONCE; only its hash is stored. */
async function rotateSecret(tenantId, siteId) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'woocommerce');
    const site = await ownedSite(tenantId, siteId);
    const db = (0, client_js_1.getDb)();
    const secret = generateHex32();
    const secretHash = await (0, ids_js_1.sha256Hex)(secret);
    await db.update(schema_js_1.wordpressSites).set({ secretHash }).where((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.id, site.id));
    await (0, audit_js_1.audit)({ action: 'wordpress.secret_rotated', actorId: tenantId, subjectType: 'wordpress_site', subjectId: site.id });
    return { secret, connectionCode: Buffer.from(`${site.siteKey}:${secret}`).toString('base64url') };
}
/**
 * Webhook authentication (§153, WORDPRESS.md): the WordPress plugin sends the
 * plaintext secret in `x-postyar-secret`; we hash it (SHA-256) and compare
 * timing-safe against the stored hash. TLS transport + per-site secret +
 * timing-safe compare = secure without storing the plaintext server-side.
 */
async function verifySiteRequest(siteKey, secret) {
    if (!siteKey || !secret)
        return null;
    const db = (0, client_js_1.getDb)();
    const [site] = await db
        .select()
        .from(schema_js_1.wordpressSites)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.siteKey, siteKey), (0, drizzle_orm_1.ne)(schema_js_1.wordpressSites.status, 'DISABLED')))
        .limit(1);
    if (!site)
        return null;
    const incomingHash = (0, node_crypto_1.createHash)('sha256').update(secret).digest('hex');
    const a = Buffer.from(incomingHash);
    const b = Buffer.from(site.secretHash);
    if (a.length !== b.length || !(0, node_crypto_1.timingSafeEqual)(a, b))
        return null;
    return { id: site.id, tenantId: site.tenantId, siteUrl: site.siteUrl, status: site.status };
}
function productContentHash(p) {
    const canonical = JSON.stringify([p.wc_id, p.title, p.price_rial ?? null, p.regular_price_rial ?? null, p.sale_price_rial ?? null, p.old_price_rial ?? null, p.stock_status ?? null, p.is_featured ?? false, p.sales_count ?? 0, p.sku ?? null, p.excerpt ?? null, p.body ?? null, p.permalink ?? null, p.image_url ?? null, p.categories ?? []]);
    return (0, node_crypto_1.createHash)('sha256').update(canonical).digest('hex');
}
/** Idempotent product sync (§23): unchanged products (same content hash) are skipped. */
async function syncProducts(site, products) {
    await (0, plan_service_js_1.assertFeature)(site.tenantId, 'woocommerce');
    if (products.length > MAX_PRODUCTS_PER_SYNC) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('تعداد محصولات هر همگام‌سازی حداکثر ۲۰۰ مورد است.'));
    }
    const db = (0, client_js_1.getDb)();
    let synced = 0;
    let skipped = 0;
    for (const p of products) {
        if (!Number.isInteger(p.wc_id) || !p.title) {
            skipped++;
            continue;
        }
        const contentHash = productContentHash(p);
        const [existing] = await db
            .select({ id: schema_js_1.wordpressProducts.id, contentHash: schema_js_1.wordpressProducts.contentHash })
            .from(schema_js_1.wordpressProducts)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.siteId, site.id), (0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.wcProductId, p.wc_id)))
            .limit(1);
        if (existing && existing.contentHash === contentHash) {
            skipped++;
            continue;
        }
        const values = {
            title: p.title.slice(0, 255),
            priceRial: typeof p.price_rial === 'number' ? Math.max(0, Math.floor(p.price_rial)) : null,
            permalink: p.permalink?.slice(0, 255) ?? null,
            imageUrl: p.image_url?.slice(0, 512) ?? null,
            regularPriceRial: p.regular_price_rial ?? null, salePriceRial: p.sale_price_rial ?? null, oldPriceRial: p.old_price_rial ?? null,
            stockStatus: p.stock_status?.slice(0, 30) ?? null, isFeatured: p.is_featured ? 1 : 0, salesCount: Math.max(0, Math.floor(p.sales_count ?? 0)), sku: p.sku?.slice(0, 190) ?? null, excerpt: p.excerpt ?? null, body: p.body ?? null,
            categoriesJson: (p.categories ?? []).slice(0, 50).map((category) => ({ id: Math.floor(category.id), name: category.name.slice(0, 255), slug: category.slug.slice(0, 200) })),
            contentHash,
            lastSyncedAt: new Date(),
        };
        if (existing) {
            await db.update(schema_js_1.wordpressProducts).set(values).where((0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.id, existing.id));
        }
        else {
            await db
                .insert(schema_js_1.wordpressProducts)
                .values({ id: (0, ids_js_1.newId)(), siteId: site.id, tenantId: site.tenantId, wcProductId: p.wc_id, ...values })
                .onDuplicateKeyUpdate({ set: values });
        }
        synced++;
    }
    await db.update(schema_js_1.wordpressSites).set({ lastSyncAt: new Date() }).where((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.id, site.id));
    if (synced > 0) {
        await (0, events_js_1.emitEvent)({
            name: 'wordpress.product.synced',
            tenantId: site.tenantId,
            subjectType: 'wordpress_site',
            subjectId: site.id,
            props: { synced, skipped },
        });
        await (0, analytics_service_js_1.recordAnalyticsEvent)({
            userId: site.tenantId,
            eventType: 'wordpress.product.synced',
            source: 'wordpress',
            value: synced,
            metadata: { siteId: site.id, synced, skipped },
        });
    }
    return { synced, skipped };
}
/**
 * publish_product → one WORDPRESS post + targets for the tenant's first 5
 * ACTIVE channels + one outbox row per channel ('wordpress.publish') which the
 * dispatcher forwards to the delivery worker (§125).
 */
async function publishProduct(site, product) {
    await (0, plan_service_js_1.assertFeature)(site.tenantId, 'woocommerce');
    if (!Number.isInteger(product.wc_id) || !product.title) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('اطلاعات محصول معتبر نیست.'));
    }
    await (0, plan_service_js_1.assertWithinLimit)(site.tenantId, 'posts');
    const db = (0, client_js_1.getDb)();
    const settings = await getSiteSettings(site);
    const priceFa = typeof product.price_rial === 'number' ? product.price_rial.toLocaleString('fa-IR') : null;
    const eventType = normalizeProductEventType(product.event_type);
    const selectedTemplateIds = (settings.automation && typeof settings.automation.templateIds === 'object' && settings.automation.templateIds !== null)
        ? settings.automation.templateIds
        : {};
    const selectedTemplateId = typeof selectedTemplateIds[eventType] === 'string' ? String(selectedTemplateIds[eventType]) : '';
    let body;
    let templateCta = null;
    const templates = await (0, template_service_js_1.listTemplates)(site.tenantId);
    const selectedTemplate = selectedTemplateId
        ? templates.find((t) => t.id === selectedTemplateId)
        : templates.find((t) => Boolean(t.isDefault) && (() => { const e = t.settingsJson && typeof t.settingsJson === 'object' ? t.settingsJson : {}; return e.eventType === eventType; })());
    if (selectedTemplateId && !selectedTemplate)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('قالب انتخاب‌شده'));
    if (selectedTemplate) {
        const regular = typeof product.regular_price_rial === 'number' ? product.regular_price_rial : null;
        const sale = typeof product.sale_price_rial === 'number' ? product.sale_price_rial : null;
        const discount = regular && sale !== null && regular > 0 ? Math.max(0, Math.min(100, Math.round(((regular - sale) / regular) * 100))) : 0;
        const templateContext = {
            title: product.title, description: product.excerpt ?? product.body ?? '', excerpt: product.excerpt ?? '', content: product.body ?? product.excerpt ?? '',
            link: product.permalink ?? site.siteUrl, date: '', author: '', site_name: (() => { try {
                return new URL(site.siteUrl).hostname;
            }
            catch {
                return site.siteUrl;
            } })(),
            post_type: 'محصول', featured_image: product.image_url ?? '', site_url: site.siteUrl, event_type: eventType, product_id: product.wc_id,
            discount_percent: discount, old_price: typeof product.old_price_rial === 'number' ? product.old_price_rial.toLocaleString('fa-IR') : '',
            price: priceFa ?? '', regular_price: typeof product.regular_price_rial === 'number' ? product.regular_price_rial.toLocaleString('fa-IR') : '',
            sale_price: typeof product.sale_price_rial === 'number' ? product.sale_price_rial.toLocaleString('fa-IR') : '', sku: product.sku ?? '', stock_status: product.stock_status === 'instock' ? 'موجود' : product.stock_status === 'outofstock' ? 'ناموجود' : product.stock_status ?? '',
        };
        const cta = selectedTemplate.settingsJson && typeof selectedTemplate.settingsJson === 'object' && selectedTemplate.settingsJson.cta && typeof selectedTemplate.settingsJson.cta === 'object' ? selectedTemplate.settingsJson.cta : null;
        if (cta && typeof cta.label === 'string' && typeof cta.url === 'string' && cta.label.trim() && cta.url.trim()) {
            const renderedCtaUrl = (0, template_service_js_1.renderTemplate)(cta.url.trim(), templateContext).trim();
            try {
                const parsed = new URL(renderedCtaUrl);
                if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname)
                    templateCta = { label: cta.label.trim(), url: renderedCtaUrl };
            }
            catch { }
        }
        body = (0, template_service_js_1.renderTemplate)(selectedTemplate.body, templateContext);
    }
    else {
        const style = settings.messageStyle ?? 'shop';
        const bodyParts = [style === 'sale' ? `🔥 ${product.title}` : style === 'minimal' ? product.title : `🛍 ${product.title}`];
        if (priceFa)
            bodyParts.push(style === 'sale' ? `قیمت ویژه: ${priceFa} ریال` : `قیمت: ${priceFa} ریال`);
        if (product.stock_status && style !== 'minimal')
            bodyParts.push(`وضعیت موجودی: ${product.stock_status}`);
        if (product.permalink)
            bodyParts.push(product.permalink);
        body = bodyParts.join('\n\n');
    }
    const requestedChannels = Array.isArray(settings.channelIds) ? settings.channelIds.slice(0, MAX_PUBLISH_CHANNELS) : [];
    const activeChannels = await db
        .select({ id: schema_js_1.channels.id })
        .from(schema_js_1.channels)
        .where(requestedChannels.length
        ? (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, site.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE'), (0, drizzle_orm_1.inArray)(schema_js_1.channels.id, requestedChannels))
        : (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, site.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE')))
        .orderBy(schema_js_1.channels.createdAt)
        .limit(MAX_PUBLISH_CHANNELS);
    if (activeChannels.length === 0) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('کانال فعالی برای انتشار محصول یافت نشد.'));
    }
    const postId = (0, ids_js_1.newId)();
    await db.transaction(async (tx) => {
        await tx.insert(schema_js_1.posts).values({
            id: postId,
            tenantId: site.tenantId,
            title: product.title.slice(0, 190),
            body,
            buttonsJson: templateCta ? { links: [{ label: templateCta.label, url: templateCta.url }] } : null,
            source: 'WORDPRESS',
            state: 'QUEUED',
        });
        for (const ch of activeChannels) {
            const targetId = (0, ids_js_1.newId)();
            await tx.insert(schema_js_1.postTargets).values({
                id: targetId,
                postId,
                tenantId: site.tenantId,
                channelId: ch.id,
                state: 'PENDING',
            });
            await tx.insert(schema_js_1.outboxEvents).values((0, outbox_js_1.outboxRow)({
                aggregateType: 'wordpress',
                aggregateId: site.id,
                eventType: 'wordpress.publish',
                payload: {
                    tenantId: site.tenantId,
                    siteId: site.id,
                    productId: product.wc_id,
                    channelId: ch.id,
                    targetId,
                    postId,
                    title: product.title,
                    body,
                    imageUrl: settings.sendImage ? (product.image_url ?? null) : null,
                },
            }));
        }
        // upsert product + stamp publish time
        const values = {
            title: product.title.slice(0, 255),
            priceRial: typeof product.price_rial === 'number' ? Math.max(0, Math.floor(product.price_rial)) : null,
            permalink: product.permalink?.slice(0, 255) ?? null,
            imageUrl: product.image_url?.slice(0, 512) ?? null,
            categoriesJson: (product.categories ?? []).slice(0, 50).map((category) => ({ id: Math.floor(category.id), name: category.name.slice(0, 255), slug: category.slug.slice(0, 200) })),
            contentHash: productContentHash(product),
            lastSyncedAt: new Date(),
        };
        await tx
            .insert(schema_js_1.wordpressProducts)
            .values({ id: (0, ids_js_1.newId)(), siteId: site.id, tenantId: site.tenantId, wcProductId: product.wc_id, ...values })
            .onDuplicateKeyUpdate({ set: values });
    });
    // The publication event is emitted by the delivery worker only after the
    // provider confirms the message. This function has only queued durable work.
    await (0, audit_js_1.audit)({ action: 'wordpress.product_queued', actorId: site.tenantId, subjectType: 'wordpress_site', subjectId: site.id, meta: { productId: product.wc_id, channels: activeChannels.length } });
    return { postId, channels: activeChannels.length };
}
async function manualSendProducts(site, products) {
    let sent = 0;
    for (const p of products.slice(0, 20)) {
        await publishProduct(site, p);
        sent++;
    }
    return { sent };
}
async function syncContents(site, contents) {
    await (0, plan_service_js_1.assertFeature)(site.tenantId, 'woocommerce');
    if (contents.length > MAX_PRODUCTS_PER_SYNC)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('تعداد مقالات هر همگام‌سازی حداکثر ۲۰۰ مورد است.'));
    const db = (0, client_js_1.getDb)();
    let synced = 0;
    let skipped = 0;
    for (const c of contents) {
        if (!Number.isInteger(c.content_id) || c.content_id < 1 || !c.title.trim()) {
            skipped++;
            continue;
        }
        const categories = (c.categories ?? []).slice(0, 50).map((category) => ({ id: Math.floor(category.id), name: category.name.slice(0, 255), slug: category.slug.slice(0, 200) }));
        const contentType = c.content_type === 'page' ? 'page' : 'post';
        const hash = (0, node_crypto_1.createHash)('sha256').update(JSON.stringify([c.content_id, c.title, c.body, c.excerpt ?? null, contentType, categories, c.permalink ?? null, c.image_url ?? null])).digest('hex');
        const [existing] = await db.select({ id: schema_js_1.wordpressContents.id, contentHash: schema_js_1.wordpressContents.contentHash })
            .from(schema_js_1.wordpressContents)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.siteId, site.id), (0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.contentId, c.content_id)))
            .limit(1);
        if (existing?.contentHash === hash) {
            skipped++;
            continue;
        }
        const values = {
            title: c.title.trim().slice(0, 255),
            body: c.body.slice(0, 60000),
            excerpt: c.excerpt?.slice(0, 5000) ?? null,
            permalink: c.permalink?.slice(0, 512) ?? null,
            imageUrl: c.image_url?.slice(0, 512) ?? null,
            contentType,
            categoriesJson: categories,
            contentHash: hash,
        };
        if (existing)
            await db.update(schema_js_1.wordpressContents).set(values).where((0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.id, existing.id));
        else
            await db.insert(schema_js_1.wordpressContents).values({ id: (0, ids_js_1.newId)(), siteId: site.id, tenantId: site.tenantId, contentId: c.content_id, postId: (0, ids_js_1.newId)(), ...values });
        synced++;
    }
    await db.update(schema_js_1.wordpressSites).set({ lastSyncAt: new Date() }).where((0, drizzle_orm_1.eq)(schema_js_1.wordpressSites.id, site.id));
    if (synced > 0)
        await (0, analytics_service_js_1.recordAnalyticsEvent)({
            userId: site.tenantId,
            eventType: 'wordpress.content.synced',
            source: 'wordpress',
            value: synced,
            metadata: { siteId: site.id, synced, skipped },
        });
    return { synced, skipped };
}
async function publishContent(site, content) {
    // Existing site credentials must not bypass a plan downgrade or revoked
    // website-integration entitlement. Keep the check at the side-effect boundary.
    await (0, plan_service_js_1.assertFeature)(site.tenantId, 'woocommerce');
    const settings = await getSiteSettings(site);
    const channelIds = settings.channelIds.slice(0, MAX_PUBLISH_CHANNELS);
    const db = (0, client_js_1.getDb)();
    const channelsToUse = channelIds.length
        ? channelIds
        : (await db.select({ id: schema_js_1.channels.id }).from(schema_js_1.channels)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, site.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channels.status, 'ACTIVE')))
            .orderBy(schema_js_1.channels.createdAt).limit(MAX_PUBLISH_CHANNELS)).map((x) => x.id);
    if (!channelsToUse.length)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('کانال فعالی برای انتشار محتوا یافت نشد.'));
    const post = await (0, post_service_js_1.createPost)(site.tenantId, {
        title: content.title.slice(0, 190),
        body: content.body,
        source: 'WORDPRESS',
    });
    try {
        await (0, post_service_js_1.publishNow)(site.tenantId, post.id, channelsToUse);
    }
    catch (error) {
        // Do not leave an orphan draft when publication failed before the post was
        // queued. If publishNow committed QUEUED state, this guarded delete is a no-op.
        await db.delete(schema_js_1.posts).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.posts.id, post.id), (0, drizzle_orm_1.eq)(schema_js_1.posts.tenantId, site.tenantId), (0, drizzle_orm_1.eq)(schema_js_1.posts.state, 'DRAFT'))).catch(() => undefined);
        throw error;
    }
    return { postId: post.id, channels: channelsToUse.length };
}
function searchPattern(q) {
    const value = String(q ?? '').trim().slice(0, 120);
    if (!value)
        return null;
    return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}
function normalizeCategoryRows(rows) {
    const categories = new Map();
    for (const row of rows) {
        if (!Array.isArray(row.categories))
            continue;
        for (const item of row.categories) {
            const id = Number(item?.id);
            const name = String(item?.name ?? '').trim();
            if (!Number.isInteger(id) || id < 1 || !name)
                continue;
            categories.set(id, { id, name: name.slice(0, 255), slug: String(item.slug ?? '').slice(0, 200) });
        }
    }
    return [...categories.values()].sort((a, b) => a.name.localeCompare(b.name, 'fa'));
}
async function listProductCategories(tenantId, siteId) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'woocommerce');
    const site = await ownedSite(tenantId, siteId);
    const db = (0, client_js_1.getDb)();
    const rows = await db.select({ categories: schema_js_1.wordpressProducts.categoriesJson }).from(schema_js_1.wordpressProducts)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.siteId, site.id)));
    return normalizeCategoryRows(rows);
}
async function listContentCategories(tenantId, siteId, contentType) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'woocommerce');
    const site = await ownedSite(tenantId, siteId);
    const db = (0, client_js_1.getDb)();
    const rows = await db.select({ categories: schema_js_1.wordpressContents.categoriesJson }).from(schema_js_1.wordpressContents)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.siteId, site.id), ...(contentType ? [(0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.contentType, contentType)] : [])));
    return normalizeCategoryRows(rows);
}
async function listContents(tenantId, page, pageSize, filters = {}) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'woocommerce');
    if (!filters.siteId)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای نمایش محتوا، ابتدا یک وب‌سایت را انتخاب کنید.'));
    const site = await ownedSite(tenantId, filters.siteId);
    const db = (0, client_js_1.getDb)();
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    const pattern = searchPattern(filters.q);
    const where = (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.siteId, site.id), ...(pattern ? [(0, drizzle_orm_1.like)(schema_js_1.wordpressContents.title, pattern)] : []), ...(filters.categoryId ? [(0, drizzle_orm_1.sql) `JSON_CONTAINS(${schema_js_1.wordpressContents.categoriesJson}, JSON_OBJECT('id', ${filters.categoryId}), '$') = 1`] : []), ...(filters.contentType ? [(0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.contentType, filters.contentType)] : []));
    const [items, totalRows] = await Promise.all([
        db.select({
            id: schema_js_1.wordpressContents.id,
            siteId: schema_js_1.wordpressContents.siteId,
            siteUrl: schema_js_1.wordpressSites.siteUrl,
            contentId: schema_js_1.wordpressContents.contentId,
            title: schema_js_1.wordpressContents.title,
            body: schema_js_1.wordpressContents.body,
            excerpt: schema_js_1.wordpressContents.excerpt,
            contentType: schema_js_1.wordpressContents.contentType,
            categories: schema_js_1.wordpressContents.categoriesJson,
            customTitle: schema_js_1.wordpressContents.customTitle,
            customBody: schema_js_1.wordpressContents.customBody,
            imageUrl: schema_js_1.wordpressContents.imageUrl,
            customImageUrl: schema_js_1.wordpressContents.customImageUrl,
            permalink: schema_js_1.wordpressContents.permalink,
            lastPublishedAt: schema_js_1.wordpressContents.lastPublishedAt,
            createdAt: schema_js_1.wordpressContents.createdAt,
        })
            .from(schema_js_1.wordpressContents)
            .leftJoin(schema_js_1.wordpressSites, (0, drizzle_orm_1.eq)(schema_js_1.wordpressContents.siteId, schema_js_1.wordpressSites.id))
            .where(where)
            .orderBy((0, drizzle_orm_1.desc)(schema_js_1.wordpressContents.createdAt))
            .limit(safeSize)
            .offset((safePage - 1) * safeSize),
        db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.wordpressContents).where(where),
    ]);
    return { items: items.map((row) => ({ ...row, contentId: Number(row.contentId) })), total: Number(totalRows[0]?.value ?? 0), page: safePage, pageSize: safeSize };
}
async function listProducts(tenantId, page, pageSize, filters = {}) {
    await (0, plan_service_js_1.assertFeature)(tenantId, 'woocommerce');
    if (!filters.siteId)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای نمایش محصولات، ابتدا یک وب‌سایت را انتخاب کنید.'));
    const site = await ownedSite(tenantId, filters.siteId);
    const db = (0, client_js_1.getDb)();
    const safePage = Math.max(1, page);
    const safeSize = Math.min(100, Math.max(1, pageSize));
    const pattern = searchPattern(filters.q);
    const where = (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.siteId, site.id), ...(pattern ? [(0, drizzle_orm_1.like)(schema_js_1.wordpressProducts.title, pattern)] : []), ...(filters.stockStatus ? [(0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.stockStatus, filters.stockStatus)] : []), ...(filters.featured ? [(0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.isFeatured, 1)] : []), ...(filters.onSale ? [(0, drizzle_orm_1.and)((0, drizzle_orm_1.isNotNull)(schema_js_1.wordpressProducts.salePriceRial), (0, drizzle_orm_1.gt)(schema_js_1.wordpressProducts.regularPriceRial, 0), (0, drizzle_orm_1.lt)(schema_js_1.wordpressProducts.salePriceRial, schema_js_1.wordpressProducts.regularPriceRial))] : []), ...(filters.categoryId ? [(0, drizzle_orm_1.sql) `JSON_CONTAINS(${schema_js_1.wordpressProducts.categoriesJson}, JSON_OBJECT('id', ${filters.categoryId}), '$') = 1`] : []));
    const [rows, totalRows] = await Promise.all([
        db.select({
            id: schema_js_1.wordpressProducts.id,
            siteId: schema_js_1.wordpressProducts.siteId,
            siteUrl: schema_js_1.wordpressSites.siteUrl,
            wcProductId: schema_js_1.wordpressProducts.wcProductId,
            title: schema_js_1.wordpressProducts.title,
            customTitle: schema_js_1.wordpressProducts.customTitle,
            priceRial: schema_js_1.wordpressProducts.priceRial,
            regularPriceRial: schema_js_1.wordpressProducts.regularPriceRial,
            salePriceRial: schema_js_1.wordpressProducts.salePriceRial,
            oldPriceRial: schema_js_1.wordpressProducts.oldPriceRial,
            stockStatus: schema_js_1.wordpressProducts.stockStatus,
            isFeatured: schema_js_1.wordpressProducts.isFeatured,
            salesCount: schema_js_1.wordpressProducts.salesCount,
            sku: schema_js_1.wordpressProducts.sku,
            excerpt: schema_js_1.wordpressProducts.excerpt,
            body: schema_js_1.wordpressProducts.body,
            categories: schema_js_1.wordpressProducts.categoriesJson,
            customBody: schema_js_1.wordpressProducts.customBody,
            permalink: schema_js_1.wordpressProducts.permalink,
            imageUrl: schema_js_1.wordpressProducts.imageUrl,
            customImageUrl: schema_js_1.wordpressProducts.customImageUrl,
            lastSyncedAt: schema_js_1.wordpressProducts.lastSyncedAt,
            lastPublishedAt: schema_js_1.wordpressProducts.lastPublishedAt,
        })
            .from(schema_js_1.wordpressProducts)
            .leftJoin(schema_js_1.wordpressSites, (0, drizzle_orm_1.eq)(schema_js_1.wordpressProducts.siteId, schema_js_1.wordpressSites.id))
            .where(where)
            .orderBy((0, drizzle_orm_1.desc)(schema_js_1.wordpressProducts.lastSyncedAt), (0, drizzle_orm_1.desc)(schema_js_1.wordpressProducts.id))
            .limit(safeSize)
            .offset((safePage - 1) * safeSize),
        db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.wordpressProducts).where(where),
    ]);
    return {
        items: rows.map((row) => ({
            ...row,
            wcProductId: Number(row.wcProductId),
            priceRial: row.priceRial === null ? null : Number(row.priceRial),
            regularPriceRial: row.regularPriceRial === null ? null : Number(row.regularPriceRial),
            salePriceRial: row.salePriceRial === null ? null : Number(row.salePriceRial),
            oldPriceRial: row.oldPriceRial === null ? null : Number(row.oldPriceRial),
            salesCount: Number(row.salesCount ?? 0),
            isFeatured: Boolean(row.isFeatured),
        })),
        total: Number(totalRows[0]?.value ?? 0),
        page: safePage,
        pageSize: safeSize,
    };
}
