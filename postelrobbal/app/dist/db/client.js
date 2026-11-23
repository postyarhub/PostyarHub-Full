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
exports.schema = void 0;
exports.getPool = getPool;
exports.initializeDbSessions = initializeDbSessions;
exports.getDb = getDb;
exports.closeDb = closeDb;
const mysql2_1 = require("drizzle-orm/mysql2");
const promise_1 = __importDefault(require("mysql2/promise"));
const env_js_1 = require("../config/env.js");
const schema = __importStar(require("./schema.js"));
exports.schema = schema;
/**
 * Conservative connection pool (§109): shared hosting budget, default max 5.
 * Single module-level pool; API/worker/scheduler each create their own process pool.
 */
let pool = null;
function getPool() {
    if (pool)
        return pool;
    const env = (0, env_js_1.loadEnv)();
    // mysql2 accepts nodejs-style URL or connection string
    pool = promise_1.default.createPool({
        uri: env.DATABASE_URL,
        connectionLimit: env.DB_POOL_MAX,
        waitForConnections: true,
        queueLimit: 20,
        timezone: 'Z',
        charset: 'utf8mb4_unicode_ci',
        enableKeepAlive: true,
    });
    // MariaDB may run with a server-local timezone on shared hosting. Session
    // timestamps must nevertheless be UTC so mysql2's Z timezone is truthful.
    pool.on('connection', (connection) => {
        void connection.query("SET time_zone = '+00:00'");
    });
    return pool;
}
/** Initialize the pool connections with a UTC session timezone before serving traffic.
 * Shared-host databases may use a local server timezone while the app serializes
 * timestamps as UTC. Sequential warm-up removes the first-request race that an
 * asynchronous pool "connection" listener alone can have.
 */
async function initializeDbSessions() {
    const p = getPool();
    const max = Math.max(1, (0, env_js_1.loadEnv)().DB_POOL_MAX);
    const held = [];
    try {
        for (let i = 0; i < max; i += 1) {
            const c = await p.getConnection();
            await c.query("SET time_zone = '+00:00'");
            held.push(c);
        }
    }
    finally {
        for (const c of held)
            c.release();
    }
}
function getDb() {
    return (0, mysql2_1.drizzle)(getPool(), { schema, mode: 'default' });
}
async function closeDb() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}
