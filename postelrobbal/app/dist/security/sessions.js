"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_COOKIE = void 0;
exports.createSession = createSession;
exports.setSessionCookie = setSessionCookie;
exports.clearSessionCookie = clearSessionCookie;
exports.resolveSession = resolveSession;
exports.revokeSession = revokeSession;
exports.revokeAllUserSessions = revokeAllUserSessions;
exports.sweepExpiredSessions = sweepExpiredSessions;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../db/client.js");
const schema_js_1 = require("../db/schema.js");
const ids_js_1 = require("../core/ids.js");
const env_js_1 = require("../config/env.js");
/**
 * Session model (ADR-0006): opaque token, server-side storage, HttpOnly
 * SameSite=Lax Secure cookie, rotation on login, server-side revocation.
 * Nothing authentication-related in localStorage (§40).
 */
exports.SESSION_COOKIE = 'py_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
async function createSession(userId, meta) {
    const db = (0, client_js_1.getDb)();
    const token = (0, ids_js_1.newToken)(32);
    const csrfSecret = (0, ids_js_1.newToken)(24);
    const id = (0, ids_js_1.newId)();
    await db.insert(schema_js_1.sessions).values({
        id,
        userId,
        tokenHash: await (0, ids_js_1.sha256Hex)(token),
        csrfSecret,
        userAgent: meta.userAgent?.slice(0, 250) ?? null,
        ip: meta.ip ?? null,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    return { token, sessionId: id, csrfSecret };
}
function setSessionCookie(reply, token) {
    const env = (0, env_js_1.loadEnv)();
    void reply.setCookie(exports.SESSION_COOKIE, token, {
        httpOnly: true,
        secure: (0, env_js_1.isProduction)(env),
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_TTL_MS / 1000,
    });
}
function clearSessionCookie(reply) {
    void reply.clearCookie(exports.SESSION_COOKIE, { path: '/' });
}
async function resolveSession(token) {
    if (!token)
        return null;
    const db = (0, client_js_1.getDb)();
    const tokenHash = await (0, ids_js_1.sha256Hex)(token);
    const [row] = await db
        .select({
        sessionId: schema_js_1.sessions.id,
        csrfSecret: schema_js_1.sessions.csrfSecret,
        expiresAt: schema_js_1.sessions.expiresAt,
        revokedAt: schema_js_1.sessions.revokedAt,
        id: schema_js_1.users.id,
        role: schema_js_1.users.role,
        email: schema_js_1.users.email,
        firstName: schema_js_1.users.firstName,
        lastName: schema_js_1.users.lastName,
        status: schema_js_1.users.status,
    })
        .from(schema_js_1.sessions)
        .innerJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.sessions.userId))
        .where((0, drizzle_orm_1.eq)(schema_js_1.sessions.tokenHash, tokenHash))
        .limit(1);
    if (!row)
        return null;
    if (row.revokedAt || row.expiresAt.getTime() < Date.now())
        return null;
    if (row.status === 'SUSPENDED')
        return null;
    return {
        id: row.id,
        role: row.role,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        status: row.status,
        sessionId: row.sessionId,
        csrfSecret: row.csrfSecret,
    };
}
/** Session rotation on login: revoke all previous sessions for credential safety. */
async function revokeSession(sessionId) {
    await (0, client_js_1.getDb)().update(schema_js_1.sessions).set({ revokedAt: new Date() }).where((0, drizzle_orm_1.eq)(schema_js_1.sessions.id, sessionId));
}
async function revokeAllUserSessions(userId) {
    await (0, client_js_1.getDb)().update(schema_js_1.sessions).set({ revokedAt: new Date() }).where((0, drizzle_orm_1.eq)(schema_js_1.sessions.userId, userId));
}
async function sweepExpiredSessions() {
    await (0, client_js_1.getDb)().delete(schema_js_1.sessions).where((0, drizzle_orm_1.lt)(schema_js_1.sessions.expiresAt, new Date()));
}
