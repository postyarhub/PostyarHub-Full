"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRoutes = healthRoutes;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../db/client.js");
const env_js_1 = require("../config/env.js");
/**
 * Health endpoints (§56, §128). /live is dependency-independent.
 * /ready performs REAL checks — never fakes readiness.
 */
async function healthRoutes(app) {
    app.get('/live', async (_req, reply) => {
        reply.header('cache-control', 'no-store');
        return { status: 'live', time: new Date().toISOString() };
    });
    app.get('/ready', async (_req, reply) => {
        const checks = {};
        let ready = true;
        const started = Date.now();
        try {
            const db = (0, client_js_1.getDb)();
            await db.execute((0, drizzle_orm_1.sql) `SELECT 1`);
            checks.mysql = { ok: true, latencyMs: Date.now() - started };
        }
        catch (err) {
            ready = false;
            checks.mysql = { ok: false, code: 'MYSQL_UNAVAILABLE' };
            app.log.error({ err }, 'health_mysql_unavailable');
        }
        try {
            const { getRedis } = await import('../queue/connection.js');
            const redis = getRedis();
            const pong = await redis.ping();
            checks.redis = { ok: pong === 'PONG' };
            if (pong !== 'PONG') {
                ready = false;
                checks.redis.code = 'REDIS_UNAVAILABLE';
            }
        }
        catch (err) {
            ready = false;
            checks.redis = { ok: false, code: 'REDIS_UNAVAILABLE' };
            app.log.error({ err }, 'health_redis_unavailable');
        }
        const env = (0, env_js_1.loadEnv)();
        reply.header('cache-control', 'no-store');
        reply.code(ready ? 200 : 503);
        if (env.NODE_ENV === 'production') {
            // Anonymous probes need only readiness status. Dependency names and
            // individual diagnostics belong in authenticated/host-side telemetry.
            return { status: ready ? 'ready' : 'degraded' };
        }
        return { status: ready ? 'ready' : 'degraded', checks, env: env.NODE_ENV };
    });
    app.get('/', async () => ({ status: 'ok', service: 'postyar-api' }));
}
