"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const buildApp_js_1 = require("./app/buildApp.js");
const routes_js_1 = require("./app/routes.js");
const env_js_1 = require("./config/env.js");
const logger_js_1 = require("./core/logger.js");
const client_js_1 = require("./db/client.js");
const connection_js_1 = require("./queue/connection.js");
const captcha_js_1 = require("./security/captcha.js");
/** API entry — one process (§54). Passenger provides PORT. */
async function main() {
    const env = (0, env_js_1.loadEnv)();
    const log = (0, logger_js_1.createLogger)('api');
    await (0, client_js_1.initializeDbSessions)();
    const app = await (0, buildApp_js_1.buildApp)();
    await (0, routes_js_1.registerApiRoutes)(app);
    const shutdown = async (signal) => {
        log.info({ signal }, 'graceful_shutdown_begin');
        try {
            await app.close();
            await (0, client_js_1.closeDb)();
            await (0, connection_js_1.closeRedis)();
            await (0, captcha_js_1.closeCaptchaStore)();
            log.info('graceful_shutdown_complete');
            process.exit(0);
        }
        catch (err) {
            log.error({ err }, 'shutdown_error');
            process.exit(1);
        }
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    log.info({ port: env.PORT }, 'api_started');
}
main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[api] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
});
