"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = createLogger;
const pino_1 = __importDefault(require("pino"));
const env_js_1 = require("../config/env.js");
/** Structured logging with redaction (§62). Never log credentials. */
function createLogger(name) {
    const env = (0, env_js_1.loadEnv)();
    return (0, pino_1.default)({
        name,
        level: env.LOG_LEVEL,
        redact: {
            paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                '*.password',
                '*.password_hash',
                '*.token',
                '*.token_encrypted',
                '*.bot_token',
                '*.api_key',
                '*.secret',
                '*.webhook_secret',
                '*.authorization',
            ],
            censor: '[REDACTED]',
        },
    });
}
