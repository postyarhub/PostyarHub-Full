"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeLoginIdentifier = normalizeLoginIdentifier;
exports.referralCodeFor = referralCodeFor;
exports.findReferrerByCode = findReferrerByCode;
exports.registerUser = registerUser;
exports.authenticate = authenticate;
exports.requestPasswordReset = requestPasswordReset;
exports.confirmPasswordReset = confirmPasswordReset;
const drizzle_orm_1 = require("drizzle-orm");
const node_crypto_1 = require("node:crypto");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const passwords_js_1 = require("../../security/passwords.js");
const ids_js_1 = require("../../core/ids.js");
const connection_js_1 = require("../../queue/connection.js");
const events_js_1 = require("../../core/events.js");
const audit_js_1 = require("../../core/audit.js");
const logger_js_1 = require("../../core/logger.js");
const email_notifications_js_1 = require("../notifications/email-notifications.js");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const passwordResetLog = (0, logger_js_1.createLogger)('password-reset');
const MOBILE_RE = /^09\d{9}$/;
function normalizeMobile(m) {
    const fa = '۰۱۲۳۴۵۶۷۸۹';
    const ar = '٠١٢٣٤٥٦٧٨٩';
    const latin = m
        .replace(/[۰-۹]/g, (d) => String(fa.indexOf(d)))
        .replace(/[٠-٩]/g, (d) => String(ar.indexOf(d)))
        .replace(/[-\s()+]/g, '');
    if (latin.startsWith('+98'))
        return `0${latin.slice(3)}`;
    if (latin.startsWith('98') && latin.length === 12)
        return `0${latin.slice(2)}`;
    return latin;
}
/** Normalize login identifiers identically for auth lookup and abuse controls. */
function normalizeLoginIdentifier(emailOrMobile) {
    const raw = emailOrMobile.trim().toLowerCase();
    return raw.includes('@') ? raw : normalizeMobile(raw);
}
/** Deterministic per-user referral code (§36). */
function referralCodeFor(userId) {
    const h = (0, node_crypto_1.createHash)('sha256').update(`postyar-ref:${userId}`).digest('base64url');
    return `R${h.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase()}`;
}
async function findReferrerByCode(code) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({ id: schema_js_1.users.id })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.referralCode, code.trim().toUpperCase()))
        .limit(1);
    return row?.id ?? null;
}
/**
 * Registration (§41-42). First-user SUPER_ADMIN enforced transactionally
 * (ADR-0007): the decision is made inside the insert transaction by a count
 * guard; a unique single-row role_bootstrap table serializes concurrent
 * first-registrations at the DB level. Client-supplied roles are ignored.
 */
async function registerUser(input, meta, bootstrapAuthorized = false) {
    if (!input.acceptTerms)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('پذیرش قوانین الزامی است.'));
    if (!(0, passwords_js_1.passwordPolicyOk)(input.password))
        throw new errors_js_1.AppError(errors_js_1.ERR.WEAK_PASSWORD());
    if (input.password !== input.passwordRepeat)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('تکرار رمز عبور مطابقت ندارد.'));
    const email = input.email.trim().toLowerCase();
    const mobile = normalizeMobile(input.mobile);
    if (!EMAIL_RE.test(email))
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ایمیل معتبر نیست.'));
    if (!MOBILE_RE.test(mobile))
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('شمارهٔ موبایل معتبر نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹).'));
    if (!input.firstName.trim() || !input.lastName.trim() || !input.businessName.trim()) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('تکمیل نام، نام خانوادگی و نام کسب‌وکار الزامی است.'));
    }
    const db = (0, client_js_1.getDb)();
    const passwordHash = await (0, passwords_js_1.hashPassword)(input.password);
    const userId = (0, ids_js_1.newId)();
    let referrerId = null;
    if (input.referralCode) {
        referrerId = await findReferrerByCode(input.referralCode);
        if (referrerId && referrerId === userId)
            referrerId = null;
    }
    try {
        await db.transaction(async (tx) => {
            let role = 'USER';
            if (bootstrapAuthorized) {
                // Existing end-user rows do not establish an administrator. Permit
                // recovery on a legacy database only when there is no SUPER_ADMIN;
                // the singleton claim below serializes concurrent bootstrap attempts.
                const existingAdmins = await tx.select({ id: schema_js_1.users.id })
                    .from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.role, 'SUPER_ADMIN')).limit(1).for('update');
                if (existingAdmins.length > 0) {
                    throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('مدیر ارشد از قبل وجود دارد؛ راه‌اندازی مدیر اولیه امکان‌پذیر نیست.'));
                }
                // The bootstrap route is protected by a separate high-entropy server
                // secret. The singleton insert is immutable: a second caller cannot
                // replace the owner or gain SUPER_ADMIN after setup is complete.
                await tx.execute((0, drizzle_orm_1.sql) `
          INSERT INTO role_bootstrap (id, user_id) VALUES (1, ${userId})
          ON DUPLICATE KEY UPDATE id = id
        `);
                const claimRaw = await tx.execute((0, drizzle_orm_1.sql) `
          SELECT user_id FROM role_bootstrap WHERE id = 1 FOR UPDATE
        `);
                let claimRows = (Array.isArray(claimRaw) ? claimRaw[0] : []);
                const claimedUserId = claimRows[0]?.user_id;
                if (claimedUserId !== userId) {
                    // A stale singleton can remain after manual/legacy administrator
                    // removal. Reclaim it only when the recorded owner is not an active
                    // SUPER_ADMIN; the singleton row lock serializes competing requests.
                    const [claimOwner] = claimedUserId
                        ? await tx.select({ id: schema_js_1.users.id, role: schema_js_1.users.role })
                            .from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, claimedUserId)).limit(1)
                        : [];
                    if (claimOwner?.role === 'SUPER_ADMIN') {
                        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('مدیر ارشد از قبل وجود دارد؛ راه‌اندازی مدیر اولیه امکان‌پذیر نیست.'));
                    }
                    await tx.execute((0, drizzle_orm_1.sql) `
            UPDATE role_bootstrap
            SET user_id = ${userId}, claimed_at = CURRENT_TIMESTAMP
            WHERE id = 1 AND user_id = ${claimedUserId ?? ''}
          `);
                    const refreshedRaw = await tx.execute((0, drizzle_orm_1.sql) `
            SELECT user_id FROM role_bootstrap WHERE id = 1 FOR UPDATE
          `);
                    claimRows = (Array.isArray(refreshedRaw) ? refreshedRaw[0] : []);
                    if (claimRows[0]?.user_id !== userId) {
                        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('راه‌اندازی مدیر اولیه قبلاً انجام شده است.'));
                    }
                }
                role = 'SUPER_ADMIN';
            }
            else {
                // Never let anonymous public registration claim administrator status.
                // On an uninitialized database ordinary registration stays closed until
                // the operator completes the explicit bootstrap flow.
                const claimRaw = await tx.execute((0, drizzle_orm_1.sql) `
          SELECT user_id FROM role_bootstrap WHERE id = 1 FOR UPDATE
        `);
                const claimRows = (Array.isArray(claimRaw) ? claimRaw[0] : []);
                if (!claimRows[0]?.user_id) {
                    throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('راه‌اندازی امن مدیر اولیه هنوز انجام نشده است.'));
                }
            }
            await tx.insert(schema_js_1.users).values({
                id: userId,
                firstName: input.firstName.trim(),
                lastName: input.lastName.trim(),
                mobile,
                email,
                businessName: input.businessName.trim(),
                businessType: input.businessType.trim(),
                passwordHash,
                referralCode: referralCodeFor(userId),
                role,
            });
            const [freePlan] = await tx.select({ id: schema_js_1.plans.id, periodDays: schema_js_1.plans.periodDays }).from(schema_js_1.plans).where((0, drizzle_orm_1.eq)(schema_js_1.plans.code, 'free')).limit(1);
            if (freePlan) {
                await tx.insert(schema_js_1.subscriptions).values({
                    id: (0, ids_js_1.newId)(),
                    tenantId: userId,
                    planId: freePlan.id,
                    state: 'ACTIVE',
                    startedAt: new Date(),
                    expiresAt: new Date(Date.now() + freePlan.periodDays * 86400_000),
                });
            }
            if (referrerId) {
                await tx
                    .insert(schema_js_1.referrals)
                    .values({
                    id: (0, ids_js_1.newId)(),
                    referrerTenantId: referrerId,
                    referredTenantId: userId,
                    referralCode: input.referralCode ?? '',
                    state: 'REGISTERED',
                })
                    .onDuplicateKeyUpdate({ set: { referredTenantId: userId } });
            }
        });
    }
    catch (err) {
        const msg = String(err.message ?? '');
        if (msg.includes('uq_users_email'))
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ثبت‌نام با این اطلاعات ممکن نیست.'));
        if (msg.includes('uq_users_mobile'))
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ثبت‌نام با این اطلاعات ممکن نیست.'));
        if (msg.includes('role_bootstrap'))
            throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('ثبت‌نام همزمان انجام شد؛ لطفاً دوباره تلاش کنید.'));
        throw err;
    }
    await (0, events_js_1.emitEvent)({ name: 'user.registration', tenantId: userId });
    if (referrerId)
        await (0, events_js_1.emitEvent)({ name: 'referral.created', tenantId: referrerId, subjectType: 'referral', subjectId: userId });
    await (0, audit_js_1.audit)({ action: 'auth.register', subjectType: 'user', subjectId: userId, ip: meta.ip });
    return { userId };
}
async function authenticate(emailOrMobile, password) {
    const db = (0, client_js_1.getDb)();
    const ident = normalizeLoginIdentifier(emailOrMobile);
    const [user] = await db
        .select()
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.sql) `${schema_js_1.users.email} = ${ident} OR ${schema_js_1.users.mobile} = ${ident}`)
        .limit(1);
    // Generic responses + constant-ish work to avoid enumeration (§180)
    if (!user) {
        await (0, passwords_js_1.hashPassword)('dummy-password-1234');
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_INVALID());
    }
    const ok = await (0, passwords_js_1.verifyPassword)(user.passwordHash, password);
    if (!ok)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_INVALID());
    if (user.status === 'SUSPENDED')
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_SUSPENDED());
    await db.update(schema_js_1.users).set({ lastLoginAt: new Date() }).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, user.id));
    await (0, events_js_1.emitEvent)({ name: 'user.login', tenantId: user.id });
    return user;
}
const PASSWORD_RESET_EMAIL_LIMIT = 3;
const PASSWORD_RESET_EMAIL_WINDOW_SECONDS = 60 * 60;
const PASSWORD_RESET_EMAIL_COUNTER_SCRIPT = [
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    'return count',
].join('\n');
async function requestPasswordReset(email) {
    const normalizedEmail = email.trim().toLowerCase();
    const emailHash = await (0, ids_js_1.sha256Hex)(normalizedEmail);
    // This short digest is an internal correlation token; never log email addresses or reset secrets.
    const emailFingerprint = emailHash.slice(0, 12);
    let requests;
    try {
        requests = Number(await (0, connection_js_1.getRedis)().eval(PASSWORD_RESET_EMAIL_COUNTER_SCRIPT, 1, `postyar:rate-limit:password-reset-email:${emailHash}`, String(PASSWORD_RESET_EMAIL_WINDOW_SECONDS)));
    }
    catch (err) {
        passwordResetLog.error({
            emailFingerprint,
            errorName: err instanceof Error ? err.name : 'UNKNOWN',
        }, 'password_reset_rate_limit_store_failed');
        // Fail closed: a reset email must not be sent without its abuse-control store.
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    }
    if (!Number.isSafeInteger(requests) || requests < 1) {
        passwordResetLog.error({ emailFingerprint, requestCount: requests }, 'password_reset_rate_limit_counter_invalid');
        return false;
    }
    const db = (0, client_js_1.getDb)();
    const [user] = await db.select({ id: schema_js_1.users.id }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.email, normalizedEmail)).limit(1);
    if (!user) {
        passwordResetLog.info({ emailFingerprint }, 'password_reset_suppressed_unknown_account');
        return false;
    }
    if (requests > PASSWORD_RESET_EMAIL_LIMIT) {
        passwordResetLog.warn({
            emailFingerprint,
            requestCount: requests,
            limit: PASSWORD_RESET_EMAIL_LIMIT,
        }, 'password_reset_suppressed_rate_limit');
        return false;
    }
    const token = (0, ids_js_1.newToken)(24);
    const passwordResetTokenId = (0, ids_js_1.newId)();
    try {
        await db.insert(schema_js_1.passwordResetTokens).values({
            id: passwordResetTokenId,
            userId: user.id,
            tokenHash: await (0, ids_js_1.sha256Hex)(token),
            expiresAt: new Date(Date.now() + 30 * 60 * 1000), // short-lived, one-time (§179)
        });
    }
    catch (err) {
        passwordResetLog.error({
            emailFingerprint,
            resetTokenId: passwordResetTokenId,
            errorName: err instanceof Error ? err.name : 'UNKNOWN',
        }, 'password_reset_token_persist_failed');
        throw err;
    }
    try {
        const { enqueuePasswordResetDelivery } = await import('../notifications/delivery.js');
        await enqueuePasswordResetDelivery(user.id, passwordResetTokenId, token);
        passwordResetLog.info({
            emailFingerprint,
            resetTokenId: passwordResetTokenId,
            requestCount: requests,
        }, 'password_reset_delivery_enqueued');
    }
    catch (err) {
        passwordResetLog.error({
            emailFingerprint,
            resetTokenId: passwordResetTokenId,
            errorName: err instanceof Error ? err.name : 'UNKNOWN',
            errorCode: err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
                ? String(err.code).slice(0, 40)
                : null,
        }, 'password_reset_delivery_enqueue_failed');
        throw err;
    }
    return true;
}
async function confirmPasswordReset(token, newPassword) {
    if (!(0, passwords_js_1.passwordPolicyOk)(newPassword))
        throw new errors_js_1.AppError(errors_js_1.ERR.WEAK_PASSWORD());
    const db = (0, client_js_1.getDb)();
    const tokenHash = await (0, ids_js_1.sha256Hex)(token);
    const [row] = await db
        .select()
        .from(schema_js_1.passwordResetTokens)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.passwordResetTokens.tokenHash, tokenHash), (0, drizzle_orm_1.isNull)(schema_js_1.passwordResetTokens.usedAt), (0, drizzle_orm_1.gt)(schema_js_1.passwordResetTokens.expiresAt, new Date())))
        .limit(1);
    if (!row)
        return false;
    const passwordHash = await (0, passwords_js_1.hashPassword)(newPassword);
    const changed = await db.transaction(async (tx) => {
        const marked = await tx
            .update(schema_js_1.passwordResetTokens)
            .set({ usedAt: new Date() })
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.passwordResetTokens.id, row.id), (0, drizzle_orm_1.isNull)(schema_js_1.passwordResetTokens.usedAt), (0, drizzle_orm_1.gt)(schema_js_1.passwordResetTokens.expiresAt, new Date())));
        const affected = Array.isArray(marked) ? Number(marked[0]?.affectedRows ?? 0) : Number(marked.affectedRows ?? 0);
        if (affected !== 1)
            return false;
        await tx.update(schema_js_1.users).set({ passwordHash }).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, row.userId));
        await tx.update(schema_js_1.sessions).set({ revokedAt: new Date() }).where((0, drizzle_orm_1.eq)(schema_js_1.sessions.userId, row.userId));
        return true;
    });
    if (!changed)
        return false;
    await (0, audit_js_1.audit)({ action: 'auth.password_reset', subjectType: 'user', subjectId: row.userId });
    await (0, email_notifications_js_1.enqueueUserEmailNotice)(row.userId, {
        subject: 'رمز عبور پُست‌یار تغییر کرد',
        preheader: 'رمز عبور حساب شما با موفقیت تغییر کرده است.',
        title: 'بازیابی رمز عبور انجام شد',
        paragraphs: ['رمز عبور حساب پُست‌یار شما تغییر کرده است. اگر این اقدام را شما انجام نداده‌اید، فوراً با پشتیبانی تماس بگیرید و امنیت حساب خود را بررسی کنید.'],
        buttonLabel: 'ورود به پنل پُست‌یار',
        buttonPath: '/login',
    }, 'password-reset-complete:' + row.id);
    return true;
}
