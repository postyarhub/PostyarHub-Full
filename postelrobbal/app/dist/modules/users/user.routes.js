"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUserRoutes = registerUserRoutes;
const zod_1 = require("zod");
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const passwords_js_1 = require("../../security/passwords.js");
const sessions_js_1 = require("../../security/sessions.js");
const csrf_js_1 = require("../../security/csrf.js");
const audit_js_1 = require("../../core/audit.js");
const validation_js_1 = require("../../core/validation.js");
const media_service_js_1 = require("../media/media.service.js");
const avatars_js_1 = require("./avatars.js");
const email_notifications_js_1 = require("../notifications/email-notifications.js");
function auth(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return { id: req.user.id };
}
const ulidish = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
function mustUlidParam(req, name) {
    const value = req.params[name];
    if (typeof value !== 'string' || !ulidish.test(value)) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('شناسه معتبر نیست.'));
    }
    return value;
}
const settingsSchema = zod_1.z.object({
    firstName: zod_1.z.string().min(1).max(80),
    lastName: zod_1.z.string().min(1).max(80),
    businessName: zod_1.z.string().min(1).max(160),
    businessType: zod_1.z.string().min(1).max(80),
    timezone: zod_1.z.string().min(1).max(64),
});
const changePasswordSchema = zod_1.z.object({
    currentPassword: zod_1.z.string().min(1).max(128),
    newPassword: zod_1.z.string().min(8).max(128),
});
const avatarCharacterSchema = zod_1.z.object({ value: zod_1.z.enum(avatars_js_1.AVATAR_CHARACTERS) });
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
/** Deletes the photo media behind a user's avatar if it still exists (no orphans). */
async function removeAvatarPhoto(userId, mediaId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({ id: schema_js_1.media.id })
        .from(schema_js_1.media)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.media.id, mediaId), (0, drizzle_orm_1.eq)(schema_js_1.media.tenantId, userId)))
        .limit(1);
    if (!row)
        return; // already gone (e.g. deleted via /media/:id) — nothing to clean
    await (0, media_service_js_1.deleteMedia)(userId, mediaId); // unlinks file + media_access_tokens + row
}
async function currentUserAvatarState(userId) {
    const db = (0, client_js_1.getDb)();
    const [u] = await db
        .select({ avatarKind: schema_js_1.users.avatarKind, avatarValue: schema_js_1.users.avatarValue, avatarMediaId: schema_js_1.users.avatarMediaId })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId))
        .limit(1);
    if (!u)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return { avatarKind: u.avatarKind, avatarValue: u.avatarValue, avatarMediaId: u.avatarMediaId };
}
async function registerUserRoutes(app) {
    app.get('/users/me/settings', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const db = (0, client_js_1.getDb)();
        const [u] = await db
            .select({
            id: schema_js_1.users.id,
            firstName: schema_js_1.users.firstName,
            lastName: schema_js_1.users.lastName,
            email: schema_js_1.users.email,
            mobile: schema_js_1.users.mobile,
            referralCode: schema_js_1.users.referralCode,
            businessName: schema_js_1.users.businessName,
            businessType: schema_js_1.users.businessType,
            timezone: schema_js_1.users.timezone,
        })
            .from(schema_js_1.users)
            .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, me.id))
            .limit(1);
        if (!u)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        return { success: true, data: u };
    });
    app.put('/users/me/settings', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const input = parse(settingsSchema, req.body);
        const db = (0, client_js_1.getDb)();
        await db
            .update(schema_js_1.users)
            .set({
            firstName: input.firstName.trim(),
            lastName: input.lastName.trim(),
            businessName: input.businessName.trim(),
            businessType: input.businessType.trim(),
            timezone: input.timezone.trim(),
        })
            .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, me.id));
        await (0, audit_js_1.audit)({ action: 'user.settings_updated', actorId: me.id, subjectType: 'user', subjectId: me.id, ip: req.ip });
        return { success: true, data: { ok: true } };
    });
    // ---- avatar (round 17) -------------------------------------------------
    // Upload a profile photo: multipart 'file' part, allowed image formats only,
    // max 5MB — re-encoded server-side to a deterministic 512×512 WebP square.
    // Replaces (and cleans up) any previous photo avatar.
    app.post('/users/me/avatar', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const file = await req.file();
        if (!file)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('فایلی ارسال نشده است.'));
        let buffer;
        try {
            buffer = await file.toBuffer();
        }
        catch {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('حجم فایل بیش از حد مجاز است.'));
        }
        const db = (0, client_js_1.getDb)();
        const [u] = await db
            .select({ id: schema_js_1.users.id, avatarKind: schema_js_1.users.avatarKind, avatarMediaId: schema_js_1.users.avatarMediaId })
            .from(schema_js_1.users)
            .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, me.id))
            .limit(1);
        if (!u)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        // Insert new media, then clean up the previous photo, then point the user
        // at the new one (avatar_value stays as the character fallback).
        const uploaded = await (0, media_service_js_1.uploadAvatarMedia)(me.id, { buffer, mimeType: file.mimetype });
        if (u.avatarKind === 'photo' && u.avatarMediaId)
            await removeAvatarPhoto(me.id, u.avatarMediaId);
        await db.update(schema_js_1.users).set({ avatarKind: 'photo', avatarMediaId: uploaded.id }).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, me.id));
        await (0, audit_js_1.audit)({ action: 'user.avatar_updated', actorId: me.id, subjectType: 'user', subjectId: me.id, ip: req.ip, meta: { kind: 'photo' } });
        return { success: true, data: { avatarKind: 'photo', avatarValue: '', avatarMediaId: uploaded.id } };
    });
    // Remove the profile photo and fall back to the standard character avatar.
    // Idempotent: with a character avatar it just returns the current state.
    app.delete('/users/me/avatar', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const current = await currentUserAvatarState(me.id);
        if (current.avatarKind === 'photo' && current.avatarMediaId) {
            await removeAvatarPhoto(me.id, current.avatarMediaId);
            const db = (0, client_js_1.getDb)();
            await db.update(schema_js_1.users).set({ avatarKind: 'character', avatarMediaId: null }).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, me.id));
            await (0, audit_js_1.audit)({ action: 'user.avatar_removed', actorId: me.id, subjectType: 'user', subjectId: me.id, ip: req.ip });
            return { success: true, data: { avatarKind: 'character', avatarValue: current.avatarValue, avatarMediaId: null } };
        }
        return { success: true, data: current };
    });
    // Pick one of the 12 standard character avatars (frontend-rendered SVG).
    // Switching away from a photo deletes that media so no orphans remain.
    app.put('/users/me/avatar/character', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const input = parse(avatarCharacterSchema, req.body);
        const db = (0, client_js_1.getDb)();
        const [u] = await db
            .select({ id: schema_js_1.users.id, avatarKind: schema_js_1.users.avatarKind, avatarMediaId: schema_js_1.users.avatarMediaId })
            .from(schema_js_1.users)
            .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, me.id))
            .limit(1);
        if (!u)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        if (u.avatarKind === 'photo' && u.avatarMediaId)
            await removeAvatarPhoto(me.id, u.avatarMediaId);
        await db
            .update(schema_js_1.users)
            .set({ avatarKind: 'character', avatarValue: input.value, avatarMediaId: null })
            .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, me.id));
        await (0, audit_js_1.audit)({
            action: 'user.avatar_updated',
            actorId: me.id,
            subjectType: 'user',
            subjectId: me.id,
            ip: req.ip,
            meta: { kind: 'character', value: input.value },
        });
        return { success: true, data: { avatarKind: 'character', avatarValue: input.value, avatarMediaId: null } };
    });
    // Serves a user's profile photo (512×512 WebP). Profile photos are social:
    // any authenticated user may view any user's avatar; character avatars are
    // frontend-rendered, so only 'photo' kind has bytes here (404 otherwise).
    app.get('/users/:id/avatar', { preHandler: [app.requireAuth] }, async (req, reply) => {
        const id = mustUlidParam(req, 'id');
        const db = (0, client_js_1.getDb)();
        const [u] = await db
            .select({ avatarKind: schema_js_1.users.avatarKind, avatarMediaId: schema_js_1.users.avatarMediaId })
            .from(schema_js_1.users)
            .where((0, drizzle_orm_1.eq)(schema_js_1.users.id, id))
            .limit(1);
        if (!u || u.avatarKind !== 'photo' || !u.avatarMediaId)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('تصویر'));
        const [row] = await db.select().from(schema_js_1.media).where((0, drizzle_orm_1.eq)(schema_js_1.media.id, u.avatarMediaId)).limit(1);
        if (!row)
            throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('تصویر'));
        void reply.header('content-type', 'image/webp');
        void reply.header('content-length', Number(row.sizeBytes));
        void reply.header('cache-control', 'private, max-age=300');
        return reply.send((0, media_service_js_1.openMediaStream)(row));
    });
    // ------------------------------------------------------------------------
    app.post('/users/me/change-password', { preHandler: [app.requireAuth] }, async (req, reply) => {
        const me = auth(req);
        const input = parse(changePasswordSchema, req.body);
        const db = (0, client_js_1.getDb)();
        const [u] = await db.select().from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, me.id)).limit(1);
        if (!u)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const ok = await (0, passwords_js_1.verifyPassword)(u.passwordHash, input.currentPassword);
        if (!ok)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('رمز عبور فعلی نادرست است.'));
        if (!(0, passwords_js_1.passwordPolicyOk)(input.newPassword))
            throw new errors_js_1.AppError(errors_js_1.ERR.WEAK_PASSWORD());
        if (input.newPassword === input.currentPassword) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('رمز جدید باید با رمز فعلی متفاوت باشد.'));
        }
        const passwordHash = await (0, passwords_js_1.hashPassword)(input.newPassword);
        await db.transaction(async (tx) => {
            await tx.update(schema_js_1.users).set({ passwordHash }).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, u.id));
            await tx.update(schema_js_1.sessions).set({ revokedAt: new Date() }).where((0, drizzle_orm_1.eq)(schema_js_1.sessions.userId, u.id));
        });
        await (0, audit_js_1.audit)({ action: 'user.password_changed', actorId: u.id, subjectType: 'user', subjectId: u.id, ip: req.ip });
        await (0, email_notifications_js_1.enqueueUserEmailNotice)(u.id, {
            subject: 'رمز عبور پُست‌یار تغییر کرد',
            preheader: 'رمز عبور حساب شما با موفقیت تغییر کرده است.',
            title: 'تغییر رمز عبور ثبت شد',
            paragraphs: ['رمز عبور حساب پُست‌یار شما تغییر کرده است. اگر این اقدام را شما انجام نداده‌اید، از پنل خارج شوید و فوراً با پشتیبانی تماس بگیرید.'],
            buttonLabel: 'ورود به پنل پُست‌یار',
            buttonPath: '/login',
        }, 'password-changed:' + u.id + ':' + Date.now());
        // Re-issue a fresh session + CSRF secret for the current device
        const session = await (0, sessions_js_1.createSession)(u.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
        (0, sessions_js_1.setSessionCookie)(reply, session.token);
        return { success: true, data: { ok: true, csrfToken: (0, csrf_js_1.issueCsrfToken)(session.csrfSecret) } };
    });
}
