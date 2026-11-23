"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAuthRoutes = registerAuthRoutes;
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const errors_js_1 = require("../../core/errors.js");
const auth_service_js_1 = require("./auth.service.js");
const register_hook_js_1 = require("../referrals/register-hook.js");
const sessions_js_1 = require("../../security/sessions.js");
const csrf_js_1 = require("../../security/csrf.js");
const captcha_js_1 = require("../../security/captcha.js");
const audit_js_1 = require("../../core/audit.js");
const client_js_1 = require("../../db/client.js");
const connection_js_1 = require("../../queue/connection.js");
const schema_js_1 = require("../../db/schema.js");
const drizzle_orm_1 = require("drizzle-orm");
const validation_js_1 = require("../../core/validation.js");
const system_settings_service_js_1 = require("../admin/system-settings.service.js");
const env_js_1 = require("../../config/env.js");
const captchaFields = {
    captchaId: zod_1.z.string().regex(/^[0-9a-f]{32}$/).optional(),
    captchaText: zod_1.z.string().min(3).max(10).optional(),
};
const registerSchema = zod_1.z.object({
    firstName: zod_1.z.string().min(1).max(80),
    lastName: zod_1.z.string().min(1).max(80),
    mobile: zod_1.z.string().min(10).max(20),
    email: zod_1.z.string().email(),
    businessName: zod_1.z.string().min(1).max(160),
    businessType: zod_1.z.string().min(1).max(80),
    password: zod_1.z.string().min(8).max(128),
    passwordRepeat: zod_1.z.string().min(8).max(128),
    acceptTerms: zod_1.z.boolean().refine((v) => v === true),
    referralCode: zod_1.z.string().max(32).optional(),
    ...captchaFields,
});
const bootstrapAdminSchema = registerSchema
    .omit({ referralCode: true })
    .extend({ bootstrapSecret: zod_1.z.string().min(32).max(256) });
const LOGIN_IDENTIFIER_FAILURE_THRESHOLD = 5;
const LOGIN_IDENTIFIER_FAILURE_WINDOW_SECONDS = 15 * 60;
const LOGIN_IDENTIFIER_FAILURE_PREFIX = 'postyar:auth:login-fail:';
const LOGIN_IDENTIFIER_FAILURE_COUNTER_SCRIPT = [
    "local count = redis.call('INCR', KEYS[1])",
    'if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end',
    'return count',
].join('\n');
function loginFailureKey(identifier) {
    const digest = (0, node_crypto_1.createHash)('sha256').update((0, auth_service_js_1.normalizeLoginIdentifier)(identifier)).digest('hex');
    return `${LOGIN_IDENTIFIER_FAILURE_PREFIX}${digest}`;
}
async function getLoginIdentifierFailures(identifier) {
    try {
        const raw = await (0, connection_js_1.getRedis)().get(loginFailureKey(identifier));
        const count = Number(raw ?? 0);
        return Number.isSafeInteger(count) && count >= 0 ? count : LOGIN_IDENTIFIER_FAILURE_THRESHOLD;
    }
    catch {
        // The existing IP limiter remains the primary control if Redis is down.
        return 0;
    }
}
async function recordLoginIdentifierFailure(identifier) {
    try {
        await (0, connection_js_1.getRedis)().eval(LOGIN_IDENTIFIER_FAILURE_COUNTER_SCRIPT, 1, loginFailureKey(identifier), String(LOGIN_IDENTIFIER_FAILURE_WINDOW_SECONDS));
    }
    catch {
        // Do not convert a rejected login into a 500 when optional abuse telemetry is unavailable.
    }
}
async function clearLoginIdentifierFailures(identifier) {
    await (0, connection_js_1.getRedis)().del(loginFailureKey(identifier)).catch(() => undefined);
}
const loginSchema = zod_1.z.object({
    identifier: zod_1.z.string().min(3).max(190),
    password: zod_1.z.string().min(1).max(128),
    ...captchaFields,
});
const CAPTCHA_FAILED = 'کد امنیتی نادرست است یا منقضی شده؛ کد جدید را وارد کنید.';
const CAPTCHA_REQUIRED = 'کد امنیتی الزامی است.';
const REGISTRATION_DISABLED = 'ثبت‌نام موقتاً غیرفعال است. لطفاً بعداً تلاش کنید.';
const resetRequestSchema = zod_1.z.object({ email: zod_1.z.string().email(), ...captchaFields });
const resetConfirmSchema = zod_1.z.object({ token: zod_1.z.string().min(10).max(200), password: zod_1.z.string().min(8).max(128) });
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
// SEC-02: independent, shared Redis bucket prevents registration limits from
// being bypassed by rotating email/mobile identity values. The IP is hashed
// before it is used in a Redis key. Redis failure is fail-closed for registration.
const REGISTRATION_IP_LIMIT = 30;
const REGISTRATION_IP_WINDOW_SECONDS = 10 * 60;
const REGISTRATION_IP_COUNTER_SCRIPT = [
    "local count = redis.call('INCR', KEYS[1])",
    "if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end",
    'return count',
].join('\n');
async function enforceRegistrationIpLimit(req) {
    const ipHash = (0, node_crypto_1.createHash)('sha256').update(String(req.ip || 'unknown')).digest('hex');
    const key = `postyar:rate-limit:auth-register-ip:${ipHash}`;
    let count;
    try {
        count = Number(await (0, connection_js_1.getRedis)().eval(REGISTRATION_IP_COUNTER_SCRIPT, 1, key, String(REGISTRATION_IP_WINDOW_SECONDS)));
    }
    catch {
        req.log.error({ requestId: req.id }, 'registration_ip_rate_limit_unavailable');
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    }
    if (!Number.isSafeInteger(count) || count < 1) {
        req.log.error({ requestId: req.id }, 'registration_ip_rate_limit_invalid_result');
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    }
    if (count > REGISTRATION_IP_LIMIT)
        throw new errors_js_1.AppError(errors_js_1.ERR.RATE_LIMITED());
}
/** Narrow req.user for TS after requireAuth preHandler. */
function authUser(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return req.user;
}
function publicUser(u) {
    return {
        id: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        businessName: u.businessName,
        role: u.role,
        timezone: u.timezone ?? 'Asia/Tehran',
        // Round 17: 'character' renders AVATAR_CHARACTERS[u.avatarValue] as SVG;
        // 'photo' serves GET /users/:id/avatar (avatarMediaId → 512×512 WebP).
        avatarKind: u.avatarKind ?? 'character',
        avatarValue: u.avatarValue ?? '',
        avatarMediaId: u.avatarMediaId ?? null,
    };
}
async function registerAuthRoutes(app) {
    // Graphical CAPTCHA challenge (public; globally one-shot through Redis).
    app.get('/auth/captcha', async (req, reply) => {
        // The shared Redis bucket bounds issuance across all API processes and
        // fails closed when abuse-control state cannot be checked.
        if (!(await (0, captcha_js_1.consumeCaptchaIssuanceSlot)(req.ip)))
            throw new errors_js_1.AppError(errors_js_1.ERR.RATE_LIMITED());
        const { captchaId, svg } = (0, captcha_js_1.issueCaptcha)(req.ip);
        reply.header('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
        reply.header('content-type', 'application/json; charset=utf-8');
        return { success: true, data: { captchaId, svg } };
    });
    // First administrator is provisioned only through an explicit,
    // high-entropy server-secret flow. It cannot promote a user after the
    // immutable role_bootstrap singleton has been claimed.
    app.post('/auth/bootstrap-admin', {
        preHandler: [enforceRegistrationIpLimit],
        config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
    }, async (req, reply) => {
        const input = parse(bootstrapAdminSchema, req.body);
        const configured = (0, env_js_1.loadEnv)().BOOTSTRAP_ADMIN_SECRET ?? '';
        const suppliedDigest = (0, node_crypto_1.createHash)('sha256').update(input.bootstrapSecret).digest();
        const configuredDigest = (0, node_crypto_1.createHash)('sha256').update(configured).digest();
        if (configured.length < 32 || !(0, node_crypto_1.timingSafeEqual)(suppliedDigest, configuredDigest)) {
            throw new errors_js_1.AppError(errors_js_1.ERR.FORBIDDEN());
        }
        const security = await (0, system_settings_service_js_1.getSecuritySettings)();
        // This route is separate from public registration and is gated by a
        // high-entropy server secret plus the one-time database claim. It must
        // remain available when routine public registration is disabled.
        if (security.captchaEnabled) {
            if (!input.captchaId || !input.captchaText)
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(CAPTCHA_REQUIRED));
            if (!(await (0, captcha_js_1.verifyCaptcha)(input.captchaId, input.captchaText, req.ip))) {
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(CAPTCHA_FAILED));
            }
        }
        const { bootstrapSecret: _secret, captchaId: _captchaId, captchaText: _captchaText, ...registration } = input;
        const { userId } = await (0, auth_service_js_1.registerUser)(registration, { ip: req.ip, userAgent: req.headers['user-agent'] }, true);
        const session = await (0, sessions_js_1.createSession)(userId, { ip: req.ip, userAgent: req.headers['user-agent'] });
        (0, sessions_js_1.setSessionCookie)(reply, session.token);
        const [user] = await (0, client_js_1.getDb)().select().from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId)).limit(1);
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
        await (0, audit_js_1.audit)({ action: 'auth.bootstrap_admin', actorId: userId, subjectType: 'user', subjectId: userId, ip: req.ip });
        return { success: true, data: { user: publicUser(user), csrfToken: (0, csrf_js_1.issueCsrfToken)(session.csrfSecret) } };
    });
    app.post('/auth/register', { preHandler: [enforceRegistrationIpLimit], config: { rateLimit: {
                max: 30,
                timeWindow: '10 minutes',
                keyGenerator: (req) => {
                    const body = req.body && typeof req.body === 'object' ? req.body : {};
                    const identity = String(body.email ?? body.mobile ?? '').trim().toLowerCase();
                    return `register:${req.ip}:${identity}`;
                },
            } } }, async (req, reply) => {
        const input = parse(registerSchema, req.body);
        // Round 17: registration kill-switch — checked BEFORE captcha and any DB write.
        const security = await (0, system_settings_service_js_1.getSecuritySettings)();
        if (!security.registrationEnabled)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(REGISTRATION_DISABLED));
        // Anti-bot gate BEFORE any DB work (item 15). One shot per code.
        if (security.captchaEnabled) {
            if (!input.captchaId || !input.captchaText)
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(CAPTCHA_REQUIRED));
            const captchaOk = await (0, captcha_js_1.verifyCaptcha)(input.captchaId, input.captchaText, req.ip);
            if (!captchaOk)
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(CAPTCHA_FAILED));
        }
        const { userId } = await (0, auth_service_js_1.registerUser)(input, { ip: req.ip, userAgent: req.headers['user-agent'] });
        // Auto-login on successful registration (session rotation included)
        const session = await (0, sessions_js_1.createSession)(userId, { ip: req.ip, userAgent: req.headers['user-agent'] });
        (0, sessions_js_1.setSessionCookie)(reply, session.token);
        const db = (0, client_js_1.getDb)();
        const [u] = await db.select().from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId)).limit(1);
        if (!u)
            throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
        await (0, register_hook_js_1.onUserRegistered)(userId).catch(() => undefined); // referral register reward (best-effort)
        return {
            success: true,
            data: { user: publicUser(u), csrfToken: (0, csrf_js_1.issueCsrfToken)(session.csrfSecret) },
        };
    });
    app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
        const input = parse(loginSchema, req.body);
        const security = await (0, system_settings_service_js_1.getSecuritySettings)();
        const failedAttempts = await getLoginIdentifierFailures(input.identifier);
        // After repeated failures against one normalized email/mobile, require a
        // one-use CAPTCHA even if the site-wide CAPTCHA toggle is off. This adds
        // an identity-scoped friction layer without locking the owner out of the
        // account or changing the generic credential error response.
        if (security.captchaEnabled || failedAttempts >= LOGIN_IDENTIFIER_FAILURE_THRESHOLD) {
            if (!input.captchaId || !input.captchaText)
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(CAPTCHA_REQUIRED));
            const captchaOk = await (0, captcha_js_1.verifyCaptcha)(input.captchaId, input.captchaText, req.ip);
            if (!captchaOk)
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(CAPTCHA_FAILED));
        }
        let user;
        try {
            user = await (0, auth_service_js_1.authenticate)(input.identifier, input.password);
        }
        catch (error) {
            if (error instanceof errors_js_1.AppError && error.code === errors_js_1.ERR.AUTH_INVALID().code) {
                await recordLoginIdentifierFailure(input.identifier);
            }
            throw error;
        }
        await clearLoginIdentifierFailures(input.identifier);
        // Session rotation on login (§40): revoke previous sessions
        await (0, sessions_js_1.revokeAllUserSessions)(user.id);
        const session = await (0, sessions_js_1.createSession)(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
        (0, sessions_js_1.setSessionCookie)(reply, session.token);
        return { success: true, data: { user: publicUser(user), csrfToken: (0, csrf_js_1.issueCsrfToken)(session.csrfSecret) } };
    });
    app.post('/auth/logout', { preHandler: [app.requireAuth] }, async (req, reply) => {
        const user = authUser(req);
        await (0, sessions_js_1.revokeSession)(user.sessionId);
        (0, sessions_js_1.clearSessionCookie)(reply);
        await (0, audit_js_1.audit)({ action: 'auth.logout', actorId: user.id, subjectType: 'user', subjectId: user.id, ip: req.ip });
        return { success: true, data: { ok: true } };
    });
    app.get('/auth/me', { preHandler: [app.requireAuth] }, async (req) => {
        const authed = authUser(req);
        const db = (0, client_js_1.getDb)();
        const [u] = await db.select().from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, authed.id)).limit(1);
        if (!u)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const [sub] = await db
            .select({ id: schema_js_1.subscriptions.id, state: schema_js_1.subscriptions.state, expiresAt: schema_js_1.subscriptions.expiresAt, planName: schema_js_1.plans.nameFa, planCode: schema_js_1.plans.code })
            .from(schema_js_1.subscriptions)
            .innerJoin(schema_js_1.plans, (0, drizzle_orm_1.eq)(schema_js_1.plans.id, schema_js_1.subscriptions.planId))
            .where((0, drizzle_orm_1.eq)(schema_js_1.subscriptions.tenantId, authed.id))
            .orderBy((0, drizzle_orm_1.desc)(schema_js_1.subscriptions.createdAt))
            .limit(1);
        const effectiveSub = (u.role === 'SUPER_ADMIN' || u.role === 'SUPPORT')
            ? {
                id: 'admin-lifetime',
                state: 'ACTIVE',
                expiresAt: '2099-12-31T23:59:59.000Z',
                planName: 'دسترسی کامل مدیریتی (نامحدود / مادام‌العمر)',
                planCode: 'lifetime_admin',
            }
            : sub ?? null;
        return {
            success: true,
            data: { user: publicUser(u), subscription: effectiveSub, csrfToken: (0, csrf_js_1.issueCsrfToken)(authed.csrfSecret) },
        };
    });
    app.post('/auth/password-reset', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
        const input = parse(resetRequestSchema, req.body);
        const security = await (0, system_settings_service_js_1.getSecuritySettings)();
        if (security.captchaEnabled) {
            if (!input.captchaId || !input.captchaText)
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(CAPTCHA_REQUIRED));
            if (!(await (0, captcha_js_1.verifyCaptcha)(input.captchaId, input.captchaText, req.ip)))
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(CAPTCHA_FAILED));
        }
        const created = await (0, auth_service_js_1.requestPasswordReset)(input.email);
        // Generic response — no account enumeration (§180)
        return {
            success: true,
            data: {
                ok: true,
                message: created
                    ? 'اگر این ایمیل در سیستم ثبت باشد، راهنمای بازیابی برای شما ارسال می‌شود.'
                    : 'اگر این ایمیل در سیستم ثبت باشد، راهنمای بازیابی برای شما ارسال می‌شود.',
            },
        };
    });
    app.post('/auth/password-reset/confirm', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
        const input = parse(resetConfirmSchema, req.body);
        const ok = await (0, auth_service_js_1.confirmPasswordReset)(input.token, input.password);
        if (!ok)
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('لینک بازیابی نامعتبر یا منقضی است.'));
        return { success: true, data: { ok: true } };
    });
}
