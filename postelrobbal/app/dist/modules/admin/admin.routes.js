"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAdminRoutes = registerAdminRoutes;
const templates_js_1 = require("../../providers/email/templates.js");
const zod_1 = require("zod");
const errors_js_1 = require("../../core/errors.js");
const validation_js_1 = require("../../core/validation.js");
const audit_js_1 = require("../../core/audit.js");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const drizzle_orm_1 = require("drizzle-orm");
const admin_service_js_1 = require("./admin.service.js");
const admin_bell_service_js_1 = require("./admin-bell.service.js");
const support_service_js_1 = require("../support/support.service.js");
const media_service_js_1 = require("../media/media.service.js");
const payment_settings_service_js_1 = require("../payments/payment-settings.service.js");
const system_settings_service_js_1 = require("./system-settings.service.js");
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
function auth(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return { id: req.user.id, role: req.user.role };
}
function paramId(req) {
    const { id } = req.params;
    return id;
}
function paging(query) {
    const page = Number.parseInt(query.page ?? '1', 10) || 1;
    const pageSize = Number.parseInt(query.pageSize ?? '20', 10) || 20;
    return { page, pageSize };
}
function platformQuery(value) {
    if (value === undefined || value === '')
        return undefined;
    if (value === 'telegram' || value === 'bale' || value === 'rubika')
        return value;
    throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مقدار انتخابی معتبر نیست.'));
}
const grantSchema = zod_1.z.object({
    planCode: zod_1.z.string().min(1).max(40),
    months: zod_1.z.coerce.number().int().min(1).max(12),
});
const planPatchSchema = zod_1.z.object({
    nameFa: zod_1.z.string().min(1).max(80).optional(),
    priceRial: zod_1.z.coerce.number().int().min(0).optional(),
    periodDays: zod_1.z.coerce.number().int().min(1).max(3650).optional(),
    isActive: zod_1.z.boolean().optional(),
    limitsJson: zod_1.z.record(zod_1.z.unknown()).optional(),
    featuresJson: zod_1.z.record(zod_1.z.unknown()).optional(),
    pricingJson: zod_1.z.record(zod_1.z.unknown()).optional(),
});
const planCreateSchema = zod_1.z.object({
    code: zod_1.z.string().min(2).max(40).regex(/^[a-z0-9_-]+$/),
    nameFa: zod_1.z.string().min(2).max(80),
    priceRial: zod_1.z.coerce.number().int().min(0),
    periodDays: zod_1.z.coerce.number().int().min(1).max(3650).default(30),
    limitsJson: zod_1.z.record(zod_1.z.unknown()).optional(),
    featuresJson: zod_1.z.record(zod_1.z.unknown()).optional(),
    pricingJson: zod_1.z.record(zod_1.z.unknown()).optional(),
});
const settingsSchema = zod_1.z
    .record(zod_1.z.unknown())
    .refine((r) => Object.keys(r).length > 0, { message: 'بدنهٔ تنظیمات خالی است.' });
// Payment gateway settings (contract 14-contract item 2). cardToCardCards is
// validated strictly: 0..5 cards, cardNumber 16..24 digits, non-empty names.
const paymentCardSchema = zod_1.z.object({
    id: zod_1.z.string().min(1).max(40).optional(),
    bankName: zod_1.z.string().min(1).max(80),
    cardNumber: zod_1.z.string().regex(/^\d{16,24}$/),
    holderName: zod_1.z.string().min(1).max(80),
});
// Per-provider gateway credentials (admin-panel v2). Strict: numbers never
// coerce to strings; unknown keys/providers are rejected.
const gatewaysPatchSchema = zod_1.z
    .object({
    zibal: zod_1.z
        .object({ merchantId: zod_1.z.string().max(128).optional(), sandbox: zod_1.z.boolean().optional() })
        .strict()
        .optional(),
    zarinpal: zod_1.z
        .object({ merchantId: zod_1.z.string().max(128).optional(), sandbox: zod_1.z.boolean().optional() })
        .strict()
        .optional(),
    idpay: zod_1.z
        .object({ apiKey: zod_1.z.string().max(128).optional(), sandbox: zod_1.z.boolean().optional() })
        .strict()
        .optional(),
    winapay: zod_1.z
        .object({ merchantId: zod_1.z.string().max(128).optional() })
        .strict()
        .optional(),
})
    .strict();
// Dedicated payment-settings PUT body (new admin UI contract).
const paymentSettingsPutSchema = zod_1.z
    .object({
    onlineEnabled: zod_1.z.boolean().optional(),
    cardToCardEnabled: zod_1.z.boolean().optional(),
    provider: zod_1.z.enum(['zibal', 'zarinpal', 'idpay', 'winapay']).optional(),
    gateways: gatewaysPatchSchema.optional(),
    cards: paymentCardSchema.array().min(0).max(5).optional(),
})
    .strict();
const approvePaymentSchema = zod_1.z.object({
    note: zod_1.z.string().min(1).max(500).optional(),
});
const rejectPaymentSchema = zod_1.z.object({
    reason: zod_1.z.string().min(3).max(500),
});
const broadcastSchema = zod_1.z.object({
    titleFa: zod_1.z.string().min(2).max(190),
    bodyFa: zod_1.z.string().min(2).max(5000),
    // Round 19: recipient targeting. Default (absent) = ALL, so the original
    // single-audience clients keep working.
    target: zod_1.z
        .union([
        zod_1.z.object({ kind: zod_1.z.literal('ALL') }).strict(),
        zod_1.z.object({ kind: zod_1.z.literal('ROLE'), role: zod_1.z.enum(['USER', 'SUPPORT', 'SUPER_ADMIN']) }).strict(),
        zod_1.z.object({ kind: zod_1.z.literal('PLAN'), planId: zod_1.z.string().min(1).max(26) }).strict(),
        zod_1.z.object({ kind: zod_1.z.literal('USERS'), userIds: zod_1.z.array(zod_1.z.string().min(1).max(26)).min(1).max(500) }).strict(),
    ])
        .optional(),
});
const releaseSchema = zod_1.z.object({
    platform: zod_1.z.enum(['telegram', 'bale', 'rubika']),
    channelRef: zod_1.z.string().min(1).max(190),
});
// ---- sms / email settings (system-settings.service) ----
const smsirConfigSchema = zod_1.z
    .object({ apiKey: zod_1.z.string().max(128).optional(), line: zod_1.z.string().max(128).optional(), otpTemplateId: zod_1.z.string().max(20).optional() })
    .strict();
const melipayamakConfigSchema = zod_1.z
    .object({ username: zod_1.z.string().max(128).optional(), password: zod_1.z.string().max(128).optional(), from: zod_1.z.string().max(128).optional() })
    .strict();
const kavenegarConfigSchema = zod_1.z
    .object({ apiKey: zod_1.z.string().max(128).optional(), from: zod_1.z.string().max(128).optional() })
    .strict();
const ghasedakConfigSchema = zod_1.z
    .object({ apiKey: zod_1.z.string().max(128).optional(), line: zod_1.z.string().max(128).optional() })
    .strict();
const smsPutSchema = zod_1.z
    .object({
    enabled: zod_1.z.boolean().optional(),
    provider: zod_1.z.enum(['smsir', 'melipayamak', 'kavenegar', 'ghasedak']).optional(),
    configs: zod_1.z
        .object({
        smsir: smsirConfigSchema.optional(),
        melipayamak: melipayamakConfigSchema.optional(),
        kavenegar: kavenegarConfigSchema.optional(),
        ghasedak: ghasedakConfigSchema.optional(),
    })
        .strict()
        .optional(),
})
    .strict();
const emailPutSchema = zod_1.z
    .object({
    enabled: zod_1.z.boolean().optional(),
    host: zod_1.z.string().max(190).optional(),
    port: zod_1.z.coerce.number().int().min(1).max(65535).optional(),
    secure: zod_1.z.boolean().optional(),
    user: zod_1.z.string().max(190).optional(),
    pass: zod_1.z.string().max(190).optional(),
    fromName: zod_1.z.string().max(80).optional(),
    fromEmail: zod_1.z
        .string()
        .max(190)
        .refine((v) => v === '' || v.includes('@'), { message: 'ایمیل معتبر نیست.' })
        .optional(),
})
    .strict();
const emailTestSchema = zod_1.z.object({
    to: zod_1.z.string().min(3).max(190).email(),
});
const emailTemplateKeySchema = zod_1.z.enum(templates_js_1.EMAIL_TEMPLATE_KEYS);
const emailTemplatePutSchema = zod_1.z.object({
    subject: zod_1.z.string().max(190).optional(),
    preheader: zod_1.z.string().max(180).optional(),
    title: zod_1.z.string().max(160).optional(),
    greeting: zod_1.z.string().max(180).optional(),
    paragraphs: zod_1.z.string().max(4000).optional(),
    buttonLabel: zod_1.z.string().max(100).optional(),
    footerNote: zod_1.z.string().max(300).optional(),
}).strict();
// ---- general / ai / referral / security settings (round 17, form-shaped) ----
const generalPutSchema = zod_1.z
    .object({
    siteNameFa: zod_1.z.string().min(1).max(60).optional(),
    siteTaglineFa: zod_1.z.string().max(120).optional(),
    supportEmail: zod_1.z
        .string()
        .max(190)
        .refine((v) => v === '' || v.includes('@'), { message: 'ایمیل معتبر نیست.' })
        .optional(),
    supportPhone: zod_1.z.string().max(20).optional(),
    supportTelegramUrl: zod_1.z
        .string()
        .max(190)
        .refine((v) => v === '' || v.startsWith('https://'), {
        message: 'آدرس تلگرام باید با https:// شروع شود.',
    })
        .optional(),
    supportBaleUrl: zod_1.z
        .string()
        .max(190)
        .refine((v) => v === '' || v.startsWith('https://'), {
        message: 'آدرس بله باید با https:// شروع شود.',
    })
        .optional(),
    termsNoteFa: zod_1.z.string().max(300).optional(),
    maintenanceEnabled: zod_1.z.boolean().optional(),
    maintenanceMessageFa: zod_1.z.string().max(300).optional(),
})
    .strict();
const aiPutSchema = zod_1.z.object({ default_provider: zod_1.z.string().min(2).max(40).optional() }).strict();
const aiProviderSchema = zod_1.z.object({
    id: zod_1.z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/).optional(),
    title: zod_1.z.string().min(2).max(100),
    kind: zod_1.z.enum(['openai-compatible', 'gemini', 'anthropic']),
    baseUrl: zod_1.z.string().url().max(190).refine((v) => v.startsWith('https://'), { message: 'آدرس سرویس‌دهنده باید با https:// شروع شود.' }),
    models: zod_1.z.array(zod_1.z.string().regex(/^\S{1,120}$/)).min(1).max(100),
    selectedModel: zod_1.z.string().regex(/^\S{1,120}$/),
    apiKey: zod_1.z.string().max(190).optional(),
}).strict();
const referralPutSchema = zod_1.z
    .object({
    registerRewardPoints: zod_1.z.number().int().min(0).max(100000).optional(),
    enabled: zod_1.z.boolean().optional(),
    firstPurchasePercent: zod_1.z.number().int().min(0).max(50).optional(),
})
    .strict();
const securityPutSchema = zod_1.z
    .object({
    registrationEnabled: zod_1.z.boolean().optional(),
    captchaEnabled: zod_1.z.boolean().optional(),
})
    .strict();
// Gold ticker bot defaults (round 18) — admin PUT validates the https://
// scheme only; the full SSRF check stays on the user-side save paths.
const goldPutSchema = zod_1.z
    .object({
    defaultSourceUrl: zod_1.z
        .string()
        .max(512)
        .refine((v) => v === '' || v.startsWith('https://'), {
        message: 'آدرس منبع پیش‌فرض باید با https:// شروع شود.',
    })
        .optional(),
    defaultFrequencyMinutes: zod_1.z.number().int().min(15).max(1440).optional(),
    defaultTemplateFa: zod_1.z.string().max(2000).optional(),
    apiToken: zod_1.z.string().max(1024).optional(),
})
    .strict();
// ---- admin support tickets (round 18) ----
const adminTicketsQuerySchema = zod_1.z
    .object({
    page: zod_1.z.coerce.number().int().min(1).optional(),
    pageSize: zod_1.z.coerce.number().int().min(1).max(100).optional(),
    state: zod_1.z.enum(['OPEN', 'ANSWERED', 'CLOSED']).optional(),
    search: zod_1.z.string().max(190).optional(),
})
    .strict();
const adminTicketReplySchema = zod_1.z
    .object({ body: zod_1.z.string().min(1).max(5000) })
    .strict();
const adminTicketCreateSchema = zod_1.z
    .object({
    tenantId: zod_1.z.string().min(1).max(26),
    subject: zod_1.z.string().min(3).max(190),
    category: zod_1.z.string().min(1).max(80).optional(),
    body: zod_1.z.string().min(1).max(5000),
})
    .strict();
const categoriesPutSchema = zod_1.z
    .object({ categories: zod_1.z.array(zod_1.z.object({ key: zod_1.z.string(), labelFa: zod_1.z.string() }).strict()).min(1).max(20) })
    .strict();
const supporterCreateSchema = zod_1.z
    .object({
    firstName: zod_1.z.string().min(2).max(80),
    lastName: zod_1.z.string().min(2).max(80),
    email: zod_1.z.string().min(3).max(190),
    mobile: zod_1.z.string().min(4).max(20),
    password: zod_1.z.string().min(8).max(128),
})
    .strict();
const supporterRoleSchema = zod_1.z
    .object({ role: zod_1.z.enum(['SUPPORT', 'USER']) })
    .strict();
/**
 * Round 19 — shared multipart parser for the two admin ticket-writing routes:
 * text fields + one optional "file" (image/*|pdf ≤10MB, magic-byte re-checked
 * by uploadMedia). JSON bodies stay accepted for API-only callers.
 */
const ADMIN_TICKET_ATTACHMENT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
const ADMIN_TICKET_ATTACHMENT_MAX = 10 * 1024 * 1024;
async function parseTicketWriteBody(req) {
    const fields = {};
    let file;
    if (req.isMultipart()) {
        for await (const part of req.parts()) {
            if (part.type === 'file') {
                if (file)
                    continue; // one attachment per message — defensive
                const mime = part.mimetype.toLowerCase();
                if (!ADMIN_TICKET_ATTACHMENT_MIME.has(mime)) {
                    throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('فرمت فایل مجاز نیست. تصویر (JPG، PNG، WebP، GIF) یا PDF ارسال کنید.'));
                }
                let buffer;
                try {
                    buffer = await part.toBuffer();
                }
                catch {
                    throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('حجم فایل بیش از حد مجاز است.'));
                }
                const fileName = (part.filename ?? 'file').trim().slice(0, 255) || 'file';
                file = { buffer, mime, fileName };
            }
            else if (part.type === 'field' && typeof part.value === 'string') {
                fields[part.fieldname] = part.value;
            }
        }
    }
    else if (req.body && typeof req.body === 'object') {
        for (const [k, v] of Object.entries(req.body)) {
            if (typeof v === 'string')
                fields[k] = v;
        }
    }
    return { fields, file };
}
async function uploadTicketAttachment(tenantId, file) {
    const uploaded = await (0, media_service_js_1.uploadMedia)(tenantId, {
        buffer: file.buffer,
        mimeType: file.mime,
        maxBytes: ADMIN_TICKET_ATTACHMENT_MAX,
    });
    return { mediaId: uploaded.id, fileName: file.fileName, sizeBytes: uploaded.sizeBytes, mime: uploaded.mime };
}
async function registerAdminRoutes(app) {
    // Every admin route requires admin.access; sensitive groups declare a finer permission.
    const access = { preHandler: [app.requirePermission('admin.access')] };
    const usersRead = { preHandler: [app.requirePermission('admin.users.read')] };
    const paymentsRead = { preHandler: [app.requirePermission('admin.payments.read')] };
    const auditRead = { preHandler: [app.requirePermission('admin.audit.read')] };
    const auditManage = { preHandler: [app.requirePermission('admin.audit.manage')] };
    const platformRead = { preHandler: [app.requirePermission('admin.platform.read')] };
    const plansRead = { preHandler: [app.requirePermission('admin.plans.read')] };
    const usersManage = { preHandler: [app.requirePermission('admin.users.manage')] };
    const paymentsReview = { preHandler: [app.requirePermission('admin.payments.review')] };
    const plansManage = { preHandler: [app.requirePermission('admin.plans.manage')] };
    const settingsManage = { preHandler: [app.requirePermission('admin.settings.manage')] };
    app.get('/admin/overview', platformRead, async () => {
        const data = await (0, admin_service_js_1.getOverview)();
        return { success: true, data };
    });
    // ---- admin bell (round 18, asovin «اعلان‌های سیستمی مدیر» parity) ----
    app.get('/admin/notifications/bell', access, async (req) => {
        const me = auth(req);
        const data = await (0, admin_bell_service_js_1.getAdminBellSnapshot)(me.id, me.role === 'SUPER_ADMIN');
        if (me.role === 'SUPPORT') {
            // Support staff should see ticket activity only. Never include payment
            // amounts, payer email or new-user details in the support bell response.
            data.pendingPayments = { count: 0, unread: 0, latest: [] };
            data.pendingSurveys = { count: 0, unread: 0, latest: [] };
            data.newUsers = { count: 0, unread: 0, latest: [] };
            data.unreadTotal = data.openTickets.unread;
        }
        return { success: true, data };
    });
    app.post('/admin/notifications/bell/seen', access, async (req) => {
        // No audit: this is a high-frequency UI marker (opening the bell popup),
        // not a state change — an audit row per popup would flood audit_logs.
        const me = auth(req);
        const data = await (0, admin_bell_service_js_1.markAdminBellSeen)(me.id);
        return { success: true, data };
    });
    // ---- channels / bots (admin-panel v2 list endpoints) ----
    app.get('/admin/channels', platformRead, async (req) => {
        const q = (req.query ?? {});
        const { page, pageSize } = paging(q);
        const platform = platformQuery(q.platform);
        const data = await (0, admin_service_js_1.listChannels)(q.search, platform, page, pageSize);
        return { success: true, data };
    });
    app.get('/admin/bots', platformRead, async (req) => {
        const q = (req.query ?? {});
        const { page, pageSize } = paging(q);
        const platform = platformQuery(q.platform);
        const data = await (0, admin_service_js_1.listBots)(q.search, platform, page, pageSize);
        return { success: true, data };
    });
    // ---- users ----
    app.get('/admin/users', usersRead, async (req) => {
        const q = (req.query ?? {});
        const { page, pageSize } = paging(q);
        const data = await (0, admin_service_js_1.listUsers)(q.search, page, pageSize);
        return { success: true, data };
    });
    // ---- user 360° profile (round 18, asovin «پروفایل ۳۶۰ درجه» parity) ----
    app.get('/admin/users/:id/profile360', usersRead, async (req) => {
        const data = await (0, admin_service_js_1.getUserProfile360)(paramId(req));
        return { success: true, data };
    });
    // ---- admin support tickets (round 18; extended round 19) ----
    app.get('/admin/support/tickets', access, async (req) => {
        const input = parse(adminTicketsQuerySchema, req.query ?? {});
        const data = await (0, support_service_js_1.adminListTickets)({
            state: input.state,
            search: input.search,
            page: input.page ?? 1,
            pageSize: input.pageSize ?? 20,
        });
        return { success: true, data: { ...data, categories: await (0, support_service_js_1.getTicketCategories)() } };
    });
    // Round 19: staff-initiated ticket for a specific user (تیکت از سمت مدیر).
    app.post('/admin/support/tickets', access, async (req) => {
        const me = auth(req);
        const { fields, file } = await parseTicketWriteBody(req);
        const input = parse(adminTicketCreateSchema, {
            tenantId: fields.tenantId ?? '',
            subject: fields.subject ?? '',
            category: fields.category ?? 'GENERAL',
            body: fields.body ?? '',
        });
        const attachment = file ? await uploadTicketAttachment(input.tenantId, file) : undefined;
        const data = await (0, support_service_js_1.adminCreateTicket)(input.tenantId, { id: me.id, role: me.role }, { subject: input.subject, category: input.category ?? 'GENERAL', body: input.body }, attachment);
        await (0, audit_js_1.audit)({ action: 'admin.ticket_created', actorId: me.id, actorRole: me.role, subjectType: 'ticket', subjectId: data.id, ip: req.ip, meta: { tenantId: input.tenantId } });
        return { success: true, data };
    });
    app.get('/admin/support/tickets/:id', access, async (req) => {
        const data = await (0, support_service_js_1.adminGetTicket)(paramId(req));
        return { success: true, data };
    });
    app.post('/admin/support/tickets/:id/messages', access, async (req) => {
        const me = auth(req);
        const id = paramId(req);
        // Round 19: multipart with optional "file" — staff can attach receipts,
        // screenshots or documents to their reply (parity with the user path).
        const { fields, file } = await parseTicketWriteBody(req);
        const input = parse(adminTicketReplySchema, { body: fields.body ?? '' });
        const attachment = file ? await uploadTicketAttachment(me.id, file) : undefined;
        await (0, support_service_js_1.adminAddTicketMessage)(id, { id: me.id, role: me.role }, input.body, attachment);
        await (0, audit_js_1.audit)({ action: 'admin.ticket_reply', actorId: me.id, actorRole: me.role, subjectType: 'ticket', subjectId: id, ip: req.ip, meta: { hasAttachment: Boolean(attachment) } });
        return { success: true, data: { ok: true } };
    });
    app.post('/admin/support/tickets/:id/close', access, async (req) => {
        const me = auth(req);
        const id = paramId(req);
        await (0, support_service_js_1.adminCloseTicket)(id, { id: me.id, role: me.role });
        await (0, audit_js_1.audit)({ action: 'admin.ticket_close', actorId: me.id, actorRole: me.role, subjectType: 'ticket', subjectId: id, ip: req.ip });
        return { success: true, data: { ok: true } };
    });
    // ---- ticket categories manager (round 19) ----
    app.get('/admin/support/categories', access, async () => {
        const data = await (0, support_service_js_1.getTicketCategories)();
        return { success: true, data };
    });
    app.put('/admin/support/categories', usersManage, async (req) => {
        const me = auth(req);
        const input = parse(categoriesPutSchema, req.body);
        const data = await (0, support_service_js_1.putTicketCategories)(input.categories);
        await (0, audit_js_1.audit)({ action: 'admin.ticket_categories_updated', actorId: me.id, actorRole: me.role, ip: req.ip, meta: { count: data.length } });
        return { success: true, data };
    });
    // ---- support team (پشتیبان‌ها, round 19) ----
    app.get('/admin/support/team', usersRead, async () => {
        const data = await (0, support_service_js_1.listSupportTeam)();
        return { success: true, data };
    });
    app.post('/admin/support/team', usersManage, async (req) => {
        const me = auth(req);
        const input = parse(supporterCreateSchema, req.body);
        const data = await (0, support_service_js_1.createSupporter)(input);
        await (0, audit_js_1.audit)({ action: 'admin.supporter_created', actorId: me.id, actorRole: me.role, subjectType: 'user', subjectId: data.id, ip: req.ip });
        return { success: true, data };
    });
    app.patch('/admin/support/team/:id', usersManage, async (req) => {
        const me = auth(req);
        const id = paramId(req);
        const input = parse(supporterRoleSchema, req.body);
        await (0, support_service_js_1.setSupporterRole)(id, input.role);
        await (0, audit_js_1.audit)({ action: 'admin.supporter_role_changed', actorId: me.id, actorRole: me.role, subjectType: 'user', subjectId: id, ip: req.ip, meta: { role: input.role } });
        return { success: true, data: { ok: true } };
    });
    app.post('/admin/users/:id/suspend', usersManage, async (req) => {
        const me = auth(req);
        const id = paramId(req);
        await (0, admin_service_js_1.setUserSuspended)(me.id, id, true);
        await (0, audit_js_1.audit)({ action: 'admin.user_suspended', actorId: me.id, actorRole: me.role, subjectType: 'user', subjectId: id, ip: req.ip });
        return { success: true, data: { ok: true } };
    });
    app.post('/admin/users/:id/activate', usersManage, async (req) => {
        const me = auth(req);
        const id = paramId(req);
        await (0, admin_service_js_1.setUserSuspended)(me.id, id, false);
        await (0, audit_js_1.audit)({ action: 'admin.user_activated', actorId: me.id, actorRole: me.role, subjectType: 'user', subjectId: id, ip: req.ip });
        return { success: true, data: { ok: true } };
    });
    // Legacy-client safety: user deletion/editing is not an exposed admin capability.
    // Explicit deny routes ensure an old/stale UI can never accidentally delete or
    // mutate the immutable SUPER_ADMIN account.
    app.delete('/admin/users/:id', usersManage, async (req) => {
        const id = paramId(req);
        const db = (0, client_js_1.getDb)();
        const [target] = await db.select({ id: schema_js_1.users.id, role: schema_js_1.users.role }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, id)).limit(1);
        if (!target)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کاربر'));
        if (target.role === 'SUPER_ADMIN')
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('حذف مدیر ارشد مجاز نیست.'));
        throw new errors_js_1.AppError(errors_js_1.ERR.FORBIDDEN());
    });
    app.patch('/admin/users/:id', usersManage, async (req) => {
        const id = paramId(req);
        const db = (0, client_js_1.getDb)();
        const [target] = await db.select({ id: schema_js_1.users.id, role: schema_js_1.users.role }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, id)).limit(1);
        if (!target)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کاربر'));
        if (target.role === 'SUPER_ADMIN')
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('ویرایش مدیر ارشد مجاز نیست.'));
        throw new errors_js_1.AppError(errors_js_1.ERR.FORBIDDEN());
    });
    app.put('/admin/users/:id', usersManage, async (req) => {
        const id = paramId(req);
        const db = (0, client_js_1.getDb)();
        const [target] = await db.select({ id: schema_js_1.users.id, role: schema_js_1.users.role }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, id)).limit(1);
        if (!target)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کاربر'));
        if (target.role === 'SUPER_ADMIN')
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('ویرایش مدیر ارشد مجاز نیست.'));
        throw new errors_js_1.AppError(errors_js_1.ERR.FORBIDDEN());
    });
    app.post('/admin/users/:id/grant-subscription', usersManage, async (req) => {
        const me = auth(req);
        const id = paramId(req);
        const input = parse(grantSchema, req.body);
        const data = await (0, admin_service_js_1.grantSubscription)(id, input.planCode, input.months);
        await (0, audit_js_1.audit)({
            action: 'admin.grant_subscription',
            actorId: me.id,
            actorRole: me.role,
            subjectType: 'user',
            subjectId: id,
            ip: req.ip,
            meta: { planCode: input.planCode, months: input.months, subscriptionId: data.subscriptionId },
        });
        return { success: true, data };
    });
    // ---- payments ----
    app.get('/admin/payments', paymentsRead, async (req) => {
        const q = (req.query ?? {});
        const { page, pageSize } = paging(q);
        // "status" per contract; legacy callers may still send "state".
        const data = await (0, admin_service_js_1.listAdminPayments)(q.status ?? q.state, page, pageSize);
        return { success: true, data };
    });
    app.post('/admin/payments/:id/approve', paymentsReview, async (req) => {
        const me = auth(req);
        const id = paramId(req);
        const input = parse(approvePaymentSchema, (req.body ?? {}));
        const before = await (0, admin_service_js_1.getPaymentState)(id);
        const data = await (0, admin_service_js_1.approvePayment)(me.id, id, input.note);
        await (0, audit_js_1.audit)({
            action: 'admin.payment_approved',
            actorId: me.id,
            actorRole: me.role,
            subjectType: 'payment',
            subjectId: id,
            ip: req.ip,
            meta: { previousState: before, note: input.note ?? null },
        });
        return { success: true, data };
    });
    app.post('/admin/payments/:id/reject', paymentsReview, async (req) => {
        const me = auth(req);
        const id = paramId(req);
        const input = parse(rejectPaymentSchema, req.body);
        const before = await (0, admin_service_js_1.getPaymentState)(id);
        const data = await (0, admin_service_js_1.rejectPayment)(me.id, id, input.reason);
        await (0, audit_js_1.audit)({
            action: 'admin.payment_rejected',
            actorId: me.id,
            actorRole: me.role,
            subjectType: 'payment',
            subjectId: id,
            ip: req.ip,
            meta: { previousState: before, reason: input.reason.slice(0, 200) },
        });
        return { success: true, data };
    });
    // ---- audit logs (admin.access) ----
    app.get('/admin/audit-logs', auditRead, async (req) => {
        const q = (req.query ?? {});
        const { page, pageSize } = paging(q);
        const data = await (0, admin_service_js_1.listAuditLogs)(q.action, page, pageSize);
        return { success: true, data };
    });
    const adminDeleteSingleHandler = async (req) => {
        const me = auth(req);
        const { id } = req.params;
        await (0, admin_service_js_1.deleteAuditLog)(id);
        await (0, audit_js_1.audit)({
            action: 'admin.audit_log_deleted',
            actorId: me.id,
            actorRole: me.role,
            subjectType: 'audit_log',
            subjectId: id,
            ip: req.ip,
        });
        return { success: true, message: 'گزارش با موفقیت حذف شد.' };
    };
    app.delete('/admin/audit-logs/:id', auditManage, adminDeleteSingleHandler);
    app.post('/admin/audit-logs/:id/delete', auditManage, adminDeleteSingleHandler);
    const adminBulkDeleteHandler = async (req) => {
        const me = auth(req);
        const body = (req.body ?? {});
        const res = await (0, admin_service_js_1.deleteAuditLogsBulk)(body);
        await (0, audit_js_1.audit)({
            action: 'admin.audit_logs_bulk_deleted',
            actorId: me.id,
            actorRole: me.role,
            ip: req.ip,
            meta: { ...body, deletedCount: res.deletedCount },
        });
        return { success: true, data: res, message: `${res.deletedCount} گزارش با موفقیت پاکسازی شد.` };
    };
    app.post('/admin/audit-logs/delete-bulk', auditManage, adminBulkDeleteHandler);
    app.post('/admin/audit-logs/bulk-delete', auditManage, adminBulkDeleteHandler);
    // ---- plans ----
    app.get('/admin/plans', plansRead, async () => {
        const data = await (0, admin_service_js_1.listPlans)();
        return { success: true, data: { plans: data } };
    });
    app.post('/admin/plans', plansManage, async (req) => {
        const me = auth(req);
        const input = parse(planCreateSchema, req.body);
        const data = await (0, admin_service_js_1.createPlan)(input);
        await (0, audit_js_1.audit)({
            action: 'admin.plan_created',
            actorId: me.id,
            actorRole: me.role,
            subjectType: 'plan',
            subjectId: data.id,
            ip: req.ip,
            meta: { code: input.code },
        });
        return { success: true, data };
    });
    app.put('/admin/plans/:id', plansManage, async (req) => {
        const me = auth(req);
        const id = paramId(req);
        const input = parse(planPatchSchema, req.body);
        await (0, admin_service_js_1.updatePlan)(id, input);
        await (0, audit_js_1.audit)({
            action: 'admin.plan_updated',
            actorId: me.id,
            actorRole: me.role,
            subjectType: 'plan',
            subjectId: id,
            ip: req.ip,
            meta: { fields: Object.keys(input) },
        });
        return { success: true, data: { ok: true } };
    });
    app.delete('/admin/plans/:id', plansManage, async (req) => {
        const me = auth(req);
        const id = paramId(req);
        await (0, admin_service_js_1.deletePlan)(id);
        await (0, audit_js_1.audit)({
            action: 'admin.plan_deleted',
            actorId: me.id,
            actorRole: me.role,
            subjectType: 'plan',
            subjectId: id,
            ip: req.ip,
        });
        return { success: true, data: { ok: true } };
    });
    // ---- system settings ----
    app.get('/admin/settings', settingsManage, async () => {
        const data = await (0, admin_service_js_1.getSettings)();
        return { success: true, data };
    });
    app.put('/admin/settings', settingsManage, async (req) => {
        const me = auth(req);
        const input = parse(settingsSchema, req.body);
        // Split payment-gateway keys from the generic object-valued settings.
        // Non-conforming payment payloads (e.g. the legacy admin page round-trips
        // every key as {}) are skipped harmlessly; conforming payloads validate
        // strictly via zod and persist.
        const paymentRaw = {};
        const generic = {};
        for (const [k, v] of Object.entries(input)) {
            if (payment_settings_service_js_1.PAYMENT_SETTING_KEYS.includes(k))
                paymentRaw[k] = v;
            else
                generic[k] = v;
        }
        let updated = 0;
        const updatedKeys = [];
        if (Object.keys(paymentRaw).length > 0) {
            const patch = paymentRaw;
            const coerced = {};
            if (typeof patch.paymentOnlineEnabled === 'boolean')
                coerced.paymentOnlineEnabled = patch.paymentOnlineEnabled;
            if (typeof patch.paymentCardToCardEnabled === 'boolean')
                coerced.paymentCardToCardEnabled = patch.paymentCardToCardEnabled;
            if (patch.paymentProvider === 'zibal' || patch.paymentProvider === 'zarinpal' || patch.paymentProvider === 'idpay' || patch.paymentProvider === 'winapay')
                coerced.paymentProvider = patch.paymentProvider;
            if (patch.paymentGateways !== undefined &&
                typeof patch.paymentGateways === 'object' &&
                !Array.isArray(patch.paymentGateways)) {
                coerced.paymentGateways = parse(gatewaysPatchSchema, patch.paymentGateways);
            }
            if (Array.isArray(patch.cardToCardCards))
                coerced.cardToCardCards = parse(paymentCardSchema.array().min(0).max(5), patch.cardToCardCards);
            if (Object.keys(coerced).length > 0) {
                const keys = await (0, payment_settings_service_js_1.putPaymentSettings)(coerced);
                updated += keys.length;
                updatedKeys.push(...keys);
            }
        }
        if (Object.keys(generic).length > 0) {
            updated += await (0, admin_service_js_1.putSettings)(generic);
            updatedKeys.push(...Object.keys(generic));
        }
        await (0, audit_js_1.audit)({
            action: 'admin.settings_updated',
            actorId: me.id,
            actorRole: me.role,
            ip: req.ip,
            meta: { keys: updatedKeys },
        });
        return { success: true, data: { updated } };
    });
    // ---- dedicated payment-gateway settings (admin-panel v2) ----
    app.get('/admin/settings/payments', settingsManage, async () => {
        const data = await (0, payment_settings_service_js_1.getPaymentSettings)();
        return { success: true, data };
    });
    app.put('/admin/settings/payments', settingsManage, async (req) => {
        const me = auth(req);
        const input = parse(paymentSettingsPutSchema, req.body);
        const patch = {};
        if (input.onlineEnabled !== undefined)
            patch.paymentOnlineEnabled = input.onlineEnabled;
        if (input.cardToCardEnabled !== undefined)
            patch.paymentCardToCardEnabled = input.cardToCardEnabled;
        if (input.provider !== undefined)
            patch.paymentProvider = input.provider;
        if (input.gateways !== undefined)
            patch.paymentGateways = input.gateways;
        if (input.cards !== undefined)
            patch.cardToCardCards = input.cards;
        const keys = await (0, payment_settings_service_js_1.putPaymentSettings)(patch);
        await (0, audit_js_1.audit)({
            action: 'admin.settings_updated',
            actorId: me.id,
            actorRole: me.role,
            ip: req.ip,
            meta: { keys },
        });
        return { success: true, data: { updated: keys.length } };
    });
    // ---- sms settings (admin-panel v2) ----
    app.get('/admin/settings/sms', settingsManage, async () => {
        const data = await (0, system_settings_service_js_1.getSmsSettings)();
        return { success: true, data };
    });
    app.put('/admin/settings/sms', settingsManage, async (req) => {
        const me = auth(req);
        const input = parse(smsPutSchema, req.body);
        const keys = await (0, system_settings_service_js_1.putSmsSettings)(input);
        await (0, audit_js_1.audit)({
            action: 'admin.settings_updated',
            actorId: me.id,
            actorRole: me.role,
            ip: req.ip,
            meta: { keys },
        });
        return { success: true, data: { updated: keys.length } };
    });
    // ---- email (SMTP) settings (admin-panel v2) ----
    app.get('/admin/settings/email', settingsManage, async () => {
        const data = await (0, system_settings_service_js_1.getPublicEmailSettings)();
        return { success: true, data };
    });
    app.put('/admin/settings/email', settingsManage, async (req) => {
        const me = auth(req);
        const input = parse(emailPutSchema, req.body);
        const keys = await (0, system_settings_service_js_1.putEmailSettings)(input);
        await (0, audit_js_1.audit)({
            action: 'admin.settings_updated',
            actorId: me.id,
            actorRole: me.role,
            ip: req.ip,
            meta: { keys },
        });
        return { success: true, data: { updated: keys.length } };
    });
    app.post('/admin/settings/email/test', settingsManage, async (req) => {
        const me = auth(req);
        const input = parse(emailTestSchema, req.body);
        const data = await (0, system_settings_service_js_1.sendTestEmail)(me.id, input.to);
        return { success: true, data };
    });
    // Editable content only: templates never accept arbitrary HTML or external CTA paths.
    app.get('/admin/settings/email/templates', settingsManage, async () => {
        const data = await (0, system_settings_service_js_1.getEmailTemplateSettings)();
        return { success: true, data };
    });
    app.put('/admin/settings/email/templates/:key', settingsManage, async (req) => {
        const me = auth(req);
        const params = parse(zod_1.z.object({ key: emailTemplateKeySchema }).strict(), req.params);
        const input = parse(emailTemplatePutSchema, req.body);
        const fields = await (0, system_settings_service_js_1.putEmailTemplateSettings)(params.key, input);
        await (0, audit_js_1.audit)({
            action: 'admin.settings_updated',
            actorId: me.id,
            actorRole: me.role,
            ip: req.ip,
            meta: { keys: ['emailTemplates'], templateKey: params.key, fields },
        });
        return { success: true, data: await (0, system_settings_service_js_1.getEmailTemplateSettings)() };
    });
    // ---- general settings (round 17): PUT is a partial patch → full snapshot ----
    app.get('/admin/settings/general', settingsManage, async () => {
        const data = await (0, system_settings_service_js_1.getGeneralSettings)();
        return { success: true, data };
    });
    app.put('/admin/settings/general', settingsManage, async (req) => {
        const me = auth(req);
        const input = parse(generalPutSchema, req.body);
        const keys = await (0, system_settings_service_js_1.putGeneralSettings)(input);
        await (0, audit_js_1.audit)({ action: 'admin.settings_updated', actorId: me.id, actorRole: me.role, ip: req.ip, meta: { keys } });
        const data = await (0, system_settings_service_js_1.getGeneralSettings)();
        return { success: true, data };
    });
    // ---- ai settings (round 17): default provider ----
    app.get('/admin/settings/ai', settingsManage, async () => {
        const data = await (0, system_settings_service_js_1.getAiSettings)();
        return { success: true, data };
    });
    app.put('/admin/settings/ai', settingsManage, async (req) => {
        const me = auth(req);
        const input = parse(aiPutSchema, req.body);
        const keys = await (0, system_settings_service_js_1.putAiSettings)(input);
        await (0, audit_js_1.audit)({ action: 'admin.settings_updated', actorId: me.id, actorRole: me.role, ip: req.ip, meta: { keys } });
        const data = await (0, system_settings_service_js_1.getAiSettings)();
        return { success: true, data };
    });
    app.post('/admin/settings/ai/providers', settingsManage, async (req) => {
        const me = auth(req);
        const input = parse(aiProviderSchema, req.body);
        const data = await (0, system_settings_service_js_1.upsertAiProvider)(input);
        await (0, audit_js_1.audit)({ action: 'admin.ai_provider_saved', actorId: me.id, actorRole: me.role, ip: req.ip, subjectType: 'ai_provider', subjectId: input.id ?? undefined });
        return { success: true, data };
    });
    app.delete('/admin/settings/ai/providers/:id', settingsManage, async (req) => {
        const me = auth(req);
        const id = String(req.params.id || '').trim().toLowerCase();
        const data = await (0, system_settings_service_js_1.deleteAiProvider)(id);
        await (0, audit_js_1.audit)({ action: 'admin.ai_provider_deleted', actorId: me.id, actorRole: me.role, ip: req.ip, subjectType: 'ai_provider', subjectId: id });
        return { success: true, data };
    });
    // ---- referral settings (round 17): register reward points ----
    app.get('/admin/settings/referral', settingsManage, async () => {
        const data = await (0, system_settings_service_js_1.getReferralSettings)();
        return { success: true, data };
    });
    app.put('/admin/settings/referral', settingsManage, async (req) => {
        const me = auth(req);
        const input = parse(referralPutSchema, req.body);
        const keys = await (0, system_settings_service_js_1.putReferralSettings)(input);
        await (0, audit_js_1.audit)({ action: 'admin.settings_updated', actorId: me.id, actorRole: me.role, ip: req.ip, meta: { keys } });
        const data = await (0, system_settings_service_js_1.getReferralSettings)();
        return { success: true, data };
    });
    // ---- security settings (round 17): registration + captcha toggles ----
    app.get('/admin/settings/security', settingsManage, async () => {
        const data = await (0, system_settings_service_js_1.getSecuritySettings)();
        return { success: true, data };
    });
    app.put('/admin/settings/security', settingsManage, async (req) => {
        const me = auth(req);
        const input = parse(securityPutSchema, req.body);
        const keys = await (0, system_settings_service_js_1.putSecuritySettings)(input);
        await (0, audit_js_1.audit)({ action: 'admin.settings_updated', actorId: me.id, actorRole: me.role, ip: req.ip, meta: { keys } });
        const data = await (0, system_settings_service_js_1.getSecuritySettings)();
        return { success: true, data };
    });
    // ---- gold ticker defaults (round 18, asovin «تنظیمات ربات طلا» parity) ----
    app.get('/admin/settings/gold', settingsManage, async () => {
        const data = await (0, system_settings_service_js_1.getGoldSettings)();
        return { success: true, data };
    });
    app.put('/admin/settings/gold', settingsManage, async (req) => {
        const me = auth(req);
        const input = parse(goldPutSchema, req.body);
        const keys = await (0, system_settings_service_js_1.putGoldSettings)(input);
        await (0, audit_js_1.audit)({ action: 'admin.settings_updated', actorId: me.id, actorRole: me.role, ip: req.ip, meta: { keys } });
        const data = await (0, system_settings_service_js_1.getGoldSettings)();
        return { success: true, data };
    });
    // ---- broadcast ----
    app.get('/admin/broadcast/targets', { preHandler: [app.requirePermission('admin.broadcast')] }, async () => {
        const data = await (0, admin_service_js_1.getBroadcastTargets)();
        return { success: true, data };
    });
    app.post('/admin/broadcast', { preHandler: [app.requirePermission('admin.broadcast')] }, async (req) => {
        const me = auth(req);
        const input = parse(broadcastSchema, req.body);
        const target = input.target ?? { kind: 'ALL' };
        const notified = await (0, admin_service_js_1.broadcast)(me.id, input.titleFa, input.bodyFa, target);
        await (0, audit_js_1.audit)({ action: 'admin.broadcast', actorId: me.id, actorRole: me.role, ip: req.ip, meta: { recipients: notified, target } });
        return { success: true, data: { notified } };
    });
    // ---- channel registry ----
    app.post('/admin/channel-registry/release', usersManage, async (req) => {
        const me = auth(req);
        const input = parse(releaseSchema, req.body);
        await (0, admin_service_js_1.releaseChannel)(me.id, input.platform, input.channelRef);
        await (0, audit_js_1.audit)({
            action: 'admin.channel_released',
            actorId: me.id,
            actorRole: me.role,
            ip: req.ip,
            meta: { platform: input.platform, channelRef: input.channelRef },
        });
        return { success: true, data: { ok: true } };
    });
}
