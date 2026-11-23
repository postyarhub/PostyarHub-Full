"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOTIFICATION_CATEGORIES = void 0;
exports.registerNotificationRoutes = registerNotificationRoutes;
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const validation_js_1 = require("../../core/validation.js");
/** Static Persian notification categories (§27). */
exports.NOTIFICATION_CATEGORIES = [
    { key: 'SUBSCRIPTION_EXPIRY_7D', labelFa: 'هشدار انقضای اشتراک', descriptionFa: 'یادآوری ۷ روز پیش از پایان اشتراک' },
    { key: 'PAYMENT', labelFa: 'پرداخت‌ها و کیف پول', descriptionFa: 'نتیجهٔ پرداخت‌ها و تغییرات موجودی' },
    { key: 'POST_STATUS', labelFa: 'وضعیت ارسال پست‌ها', descriptionFa: 'موفقیت یا شکست ارسال‌ها' },
    { key: 'BOT_EVENTS', labelFa: 'رویدادهای ربات', descriptionFa: 'پیام‌ها و تعامل‌های ربات' },
    { key: 'BROADCAST', labelFa: 'اطلاعیه‌های پُست‌یار', descriptionFa: 'اخبار و اطلاعیه‌های سرویس' },
    { key: 'PASSWORD_RESET', labelFa: 'امنیت حساب', descriptionFa: 'بازیابی رمز عبور و هشدارهای امنیتی' },
    { key: 'SURVEY_APPROVED', labelFa: 'نتیجهٔ بررسی نظرسنجی', descriptionFa: 'اعلان تأیید و انتشار نظرسنجی ثبت‌شده' },
    { key: 'SURVEY_REJECTED', labelFa: 'نتیجهٔ بررسی نظرسنجی', descriptionFa: 'اعلان رد نظرسنجی و دلیل ثبت‌شده' },
    { key: 'SURVEY_CLOSED', labelFa: 'وضعیت نظرسنجی', descriptionFa: 'اعلان توقف نمایش نظرسنجی' },
];
function prefKey(tenantId) {
    return `notif_pref:${tenantId}`;
}
async function readPrefs(tenantId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({ valueJson: schema_js_1.systemSettings.valueJson })
        .from(schema_js_1.systemSettings)
        .where((0, drizzle_orm_1.eq)(schema_js_1.systemSettings.settingKey, prefKey(tenantId)))
        .limit(1);
    const raw = row?.valueJson;
    if (!raw || typeof raw !== 'object')
        return {};
    const out = {};
    for (const cat of exports.NOTIFICATION_CATEGORIES) {
        const v = raw[cat.key];
        if (typeof v === 'boolean')
            out[cat.key] = v;
    }
    return out;
}
const prefsSchema = zod_1.z.object({
    prefs: zod_1.z.record(zod_1.z.boolean()).refine((r) => Object.keys(r).every((k) => exports.NOTIFICATION_CATEGORIES.some((c) => c.key === k)) && Object.keys(r).length > 0, { message: 'کلیدهای دسته‌بندی معتبر نیستند.' }),
});
function auth(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return { id: req.user.id };
}
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
async function registerNotificationRoutes(app) {
    app.get('/notifications', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const q = (req.query ?? {});
        const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
        const pageSize = Math.min(100, Math.max(1, Number.parseInt(q.pageSize ?? '20', 10) || 20));
        const unreadOnly = q.unreadOnly === 'true' || q.unreadOnly === '1';
        const db = (0, client_js_1.getDb)();
        const where = unreadOnly
            ? (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.notifications.tenantId, me.id), (0, drizzle_orm_1.isNull)(schema_js_1.notifications.readAt))
            : (0, drizzle_orm_1.eq)(schema_js_1.notifications.tenantId, me.id);
        const [totalRow] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.notifications).where(where);
        const rows = await db
            .select({
            id: schema_js_1.notifications.id,
            kind: schema_js_1.notifications.kind,
            titleFa: schema_js_1.notifications.titleFa,
            bodyFa: schema_js_1.notifications.bodyFa,
            readAt: schema_js_1.notifications.readAt,
            createdAt: schema_js_1.notifications.createdAt,
        })
            .from(schema_js_1.notifications)
            .where(where)
            .orderBy((0, drizzle_orm_1.desc)(schema_js_1.notifications.createdAt))
            .limit(pageSize)
            .offset((page - 1) * pageSize);
        // Round 18 fix: the user dashboard bell badge reads `d.unread` — count of
        // this tenant's notifications with readAt IS NULL (independent of paging /
        // the unreadOnly filter).
        const [unreadRow] = await db
            .select({ value: (0, drizzle_orm_1.count)() })
            .from(schema_js_1.notifications)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.notifications.tenantId, me.id), (0, drizzle_orm_1.isNull)(schema_js_1.notifications.readAt)));
        return {
            success: true,
            data: {
                items: rows,
                unread: Number(unreadRow?.value ?? 0),
                total: Number(totalRow?.value ?? 0),
                page,
                pageSize,
            },
        };
    });
    app.post('/notifications/:id/read', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const { id } = req.params;
        const db = (0, client_js_1.getDb)();
        await db
            .update(schema_js_1.notifications)
            .set({ readAt: new Date() })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.notifications.id, id), (0, drizzle_orm_1.eq)(schema_js_1.notifications.tenantId, me.id), (0, drizzle_orm_1.isNull)(schema_js_1.notifications.readAt)));
        return { success: true, data: { ok: true } };
    });
    app.post('/notifications/read-all', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const db = (0, client_js_1.getDb)();
        await db
            .update(schema_js_1.notifications)
            .set({ readAt: new Date() })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.notifications.tenantId, me.id), (0, drizzle_orm_1.isNull)(schema_js_1.notifications.readAt)));
        return { success: true, data: { ok: true } };
    });
    app.get('/notifications/preferences', { preHandler: [app.requireAuth] }, async (req) => {
        const stored = await readPrefs(auth(req).id);
        const categories = exports.NOTIFICATION_CATEGORIES.map((c) => ({
            key: c.key,
            labelFa: c.labelFa,
            descriptionFa: c.descriptionFa,
            enabled: stored[c.key] ?? true,
        }));
        return { success: true, data: { categories } };
    });
    app.put('/notifications/preferences', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const input = parse(prefsSchema, req.body);
        const db = (0, client_js_1.getDb)();
        const current = await readPrefs(me.id);
        const merged = { ...current, ...input.prefs };
        await db
            .insert(schema_js_1.systemSettings)
            .values({
            settingKey: prefKey(me.id),
            valueJson: merged,
        })
            .onDuplicateKeyUpdate({ set: { valueJson: merged } });
        return { success: true, data: { ok: true } };
    });
}
