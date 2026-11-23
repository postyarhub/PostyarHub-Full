"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.audit = audit;
const client_js_1 = require("../db/client.js");
const schema_js_1 = require("../db/schema.js");
const ids_js_1 = require("./ids.js");
/** Audit logging for sensitive actions (§63). No credentials in meta. */
async function audit(input) {
    const clean = {};
    if (input.meta) {
        for (const [k, v] of Object.entries(input.meta)) {
            if (/secret|token|password|key|credential/i.test(k))
                continue;
            clean[k] = typeof v === 'string' && v.length > 500 ? v.slice(0, 500) : v;
        }
    }
    await (0, client_js_1.getDb)()
        .insert(schema_js_1.auditLogs)
        .values({
        id: (0, ids_js_1.newId)(),
        actorId: input.actorId ?? null,
        actorRole: input.actorRole ?? null,
        action: input.action,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        ip: input.ip ?? null,
        metaJson: Object.keys(clean).length ? clean : null,
    })
        .catch(() => undefined); // auditing must never break the request path
}
