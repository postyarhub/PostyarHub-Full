"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildApp = buildApp;
const fastify_1 = __importDefault(require("fastify"));
const cookie_1 = __importDefault(require("@fastify/cookie"));
const cors_1 = __importDefault(require("@fastify/cors"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const multipart_1 = __importDefault(require("@fastify/multipart"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const node_crypto_1 = require("node:crypto");
const node_querystring_1 = require("node:querystring");
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const env_js_1 = require("../config/env.js");
const errors_js_1 = require("../core/errors.js");
const sessions_js_1 = require("../security/sessions.js");
const csrf_js_1 = require("../security/csrf.js");
const permissions_js_1 = require("../security/permissions.js");
const health_js_1 = require("./health.js");
const connection_js_1 = require("../queue/connection.js");
const diagnostic_scrub_js_1 = require("../core/diagnostic-scrub.js");
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const INTERNAL_ERROR_LOG_PATH = path.resolve(__dirname, '../../../logs/api-internal-errors.jsonl');
const INTERNAL_ERROR_LOG_MAX_BYTES = 1024 * 1024;
const INTERNAL_ERROR_TRACE_SAMPLE_INTERVAL_MS = 5_000;
const INTERNAL_ERROR_TRACE_MAX_SIGNATURES = 512;
const internalErrorTraceLastWrittenAt = new Map();
function shouldPersistInternalErrorTrace(req, err, status, code) {
    const now = Date.now();
    const errorName = err instanceof Error ? err.name : 'NonError';
    const route = req.routeOptions?.url ?? req.url.split('?')[0] ?? '/';
    const signature = `${req.method}:${route}:${status}:${code}:${errorName}`;
    const previous = internalErrorTraceLastWrittenAt.get(signature);
    if (previous !== undefined && now - previous < INTERNAL_ERROR_TRACE_SAMPLE_INTERVAL_MS)
        return false;
    // Refresh insertion order and bound memory. The normal application logger
    // still records request failures; this file is a sampled diagnostic trace.
    internalErrorTraceLastWrittenAt.delete(signature);
    internalErrorTraceLastWrittenAt.set(signature, now);
    if (internalErrorTraceLastWrittenAt.size > INTERNAL_ERROR_TRACE_MAX_SIGNATURES) {
        for (const [key, writtenAt] of internalErrorTraceLastWrittenAt) {
            if (now - writtenAt >= INTERNAL_ERROR_TRACE_SAMPLE_INTERVAL_MS)
                internalErrorTraceLastWrittenAt.delete(key);
        }
        while (internalErrorTraceLastWrittenAt.size > INTERNAL_ERROR_TRACE_MAX_SIGNATURES) {
            const oldest = internalErrorTraceLastWrittenAt.keys().next();
            if (oldest.done)
                break;
            internalErrorTraceLastWrittenAt.delete(oldest.value);
        }
    }
    return true;
}
/** Persist sampled server-side 5xx diagnostics; never record request bodies or credentials. */
async function persistInternalErrorTrace(req, err, status, code) {
    if (!shouldPersistInternalErrorTrace(req, err, status, code))
        return;
    try {
        const error = err instanceof Error ? err : new Error(String(err));
        const directory = path.dirname(INTERNAL_ERROR_LOG_PATH);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        try {
            const current = await fs.stat(INTERNAL_ERROR_LOG_PATH);
            if (current.size >= INTERNAL_ERROR_LOG_MAX_BYTES) {
                const rotated = `${INTERNAL_ERROR_LOG_PATH}.1`;
                await fs.unlink(rotated).catch(() => undefined);
                await fs.rename(INTERNAL_ERROR_LOG_PATH, rotated).catch(async () => {
                    await fs.truncate(INTERNAL_ERROR_LOG_PATH, 0).catch(() => undefined);
                });
            }
        }
        catch {
            // The log does not exist yet; appendFile creates it below.
        }
        const { errorName, errorMessage, stackPresent } = (0, diagnostic_scrub_js_1.safeInternalErrorFields)(error);
        const record = {
            timestamp: new Date().toISOString(),
            requestId: req.id,
            method: req.method,
            route: req.routeOptions?.url ?? req.url.split('?')[0],
            status,
            code,
            errorName,
            errorMessage,
            stackPresent,
        };
        await fs.appendFile(INTERNAL_ERROR_LOG_PATH, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.chmod(INTERNAL_ERROR_LOG_PATH, 0o600);
    }
    catch (writeError) {
        req.log.error({ writeErrorName: writeError instanceof Error ? (0, diagnostic_scrub_js_1.safeInternalErrorFields)(writeError).errorName : 'NonError', requestId: req.id }, 'internal_error_trace_write_failed');
    }
}
async function buildApp() {
    const env = (0, env_js_1.loadEnv)();
    const trustedProxyIps = new Set(env.TRUST_PROXY_IPS.split(',').map((v) => v.trim()).filter(Boolean));
    const app = (0, fastify_1.default)({
        logger: { level: env.LOG_LEVEL },
        trustProxy: (address) => trustedProxyIps.has(address),
        bodyLimit: 2 * 1024 * 1024,
        requestTimeout: env.REQUEST_TIMEOUT_MS,
        keepAliveTimeout: env.KEEP_ALIVE_TIMEOUT_MS,
        connectionTimeout: 10_000,
        genReqId: () => (0, node_crypto_1.randomUUID)(),
    });
    await app.register(helmet_1.default, {
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
                connectSrc: ["'self'"],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
            },
        },
        hsts: (0, env_js_1.isProduction)(env) ? { maxAge: 31536000, includeSubDomains: true } : false,
    });
    await app.register(cors_1.default, {
        origin: env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    });
    await app.register(cookie_1.default, { secret: env.SESSION_SECRET, parseOptions: { sameSite: 'lax' } });
    await app.register(multipart_1.default, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    // WinaPay posts its callback as application/x-www-form-urlencoded. Keep this parser
    // local and dependency-free so the webhook can coexist with the JSON API.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
        try {
            done(null, (0, node_querystring_1.parse)(String(body)));
        }
        catch (err) {
            done(err, undefined);
        }
    });
    // request id + observability (§129)
    app.addHook('onRequest', async (req) => {
        req.raw.startedAt = Date.now();
    });
    app.addHook('onSend', async (req, reply) => {
        if (req.url.startsWith('/api/')) {
            reply.header('cache-control', 'private, no-store, max-age=0');
        }
    });
    app.addHook('onResponse', async (req, reply) => {
        const startedAt = req.raw.startedAt ?? Date.now();
        reply.log.info({
            method: req.method,
            // Query parameters may contain webhook secrets and short-lived media
            // tokens. Log the matched route (or path only for unmatched requests).
            url: req.routeOptions?.url ?? req.url.split('?')[0],
            status: reply.statusCode,
            durationMs: Date.now() - startedAt,
            requestId: req.id,
        }, 'http_request');
    });
    // session resolution
    app.addHook('onRequest', async (req) => {
        const token = req.cookies['py_session'];
        const session = await (0, sessions_js_1.resolveSession)(token);
        if (session) {
            req.user = session;
            // CSRF for mutating requests (skip provider webhooks registered separately)
            const requestPath = req.url.split('?')[0] ?? req.url;
            const isBotProviderWebhook = /^\/api\/v1\/webhooks\/bots\/[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/.test(requestPath);
            const isPaymentProviderCallback = requestPath === '/api/v1/payments/callback';
            if (MUTATING.has(req.method) && !isBotProviderWebhook && !isPaymentProviderCallback) {
                const header = req.headers['x-csrf-token'];
                if (!(0, csrf_js_1.verifyCsrfToken)(Array.isArray(header) ? header[0] : header, session.csrfSecret)) {
                    throw new errors_js_1.AppError(errors_js_1.ERR.CSRF_INVALID());
                }
            }
        }
    });
    // Register rate limiting after session resolution so authenticated route
    // key generators can safely use req.user. Public auth routes still fall back
    // to req.ip because no session exists yet.
    await app.register(rate_limit_1.default, {
        global: false,
        max: 300,
        timeWindow: '1 minute',
        redis: (0, connection_js_1.getRedis)(),
    });
    // auth decorators
    app.decorate('requireAuth', async (req) => {
        if (!req.user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    });
    app.decorate('requirePermission', (permission) => async (req) => {
        if (!req.user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        if (!(0, permissions_js_1.roleHasPermission)(req.user.role, permission))
            throw new errors_js_1.AppError(errors_js_1.ERR.FORBIDDEN());
    });
    // unified error handler (§58): stable code + safe Persian message + requestId
    app.setErrorHandler(async (err, req, reply) => {
        if (err instanceof errors_js_1.AppError) {
            if (err.httpStatus >= 500) {
                req.log.error({ requestId: req.id, code: err.code, errorClass: err.errorClass, err }, 'app_internal_error');
                await persistInternalErrorTrace(req, err, err.httpStatus, err.code);
            }
            void reply.status(err.httpStatus).send({
                success: false,
                error: { code: err.code, message: err.userMessage, requestId: req.id },
            });
            return;
        }
        if (typeof err.statusCode === 'number') {
            const status = err.statusCode;
            if (status === 429) {
                void reply.status(429).send({
                    success: false,
                    error: { code: 'RATE_LIMITED', message: 'تعداد درخواست‌ها بیش از حد مجاز است. کمی بعد تلاش کنید.', requestId: req.id },
                });
                return;
            }
            if (status === 413) {
                void reply.status(413).send({
                    success: false,
                    error: { code: 'PAYLOAD_TOO_LARGE', message: 'حجم فایل یا دادهٔ ارسالی بیش از حد مجاز است.', requestId: req.id },
                });
                return;
            }
            if (status >= 400 && status < 500) {
                void reply.status(status).send({
                    success: false,
                    error: { code: 'BAD_REQUEST', message: 'درخواست معتبر نیست.', requestId: req.id },
                });
                return;
            }
        }
        req.log.error({ err }, 'unhandled_error');
        const pub = (0, errors_js_1.toPublicError)(err);
        if (pub.httpStatus >= 500)
            await persistInternalErrorTrace(req, err, pub.httpStatus, pub.code);
        void reply.status(pub.httpStatus).send({
            success: false,
            error: { code: pub.code, message: pub.userMessage, requestId: req.id },
        });
    });
    app.setNotFoundHandler((req, reply) => {
        void reply.status(404).send({
            success: false,
            error: { code: 'NOT_FOUND', message: 'مسیر مورد نظر یافت نشد.', requestId: req.id },
        });
    });
    await app.register(health_js_1.healthRoutes, { prefix: '/api/health' });
    return app;
}
