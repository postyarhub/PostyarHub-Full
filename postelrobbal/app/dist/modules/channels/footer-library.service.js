"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listSavedFooters = listSavedFooters;
exports.saveChannelFooter = saveChannelFooter;
exports.deleteSavedFooter = deleteSavedFooter;
const node_crypto_1 = require("node:crypto");
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const errors_js_1 = require("../../core/errors.js");
const audit_js_1 = require("../../core/audit.js");
async function requireOwnedChannel(tenantId, channelId) {
    const [channel] = await (0, client_js_1.getDb)().select({ id: schema_js_1.channels.id }).from(schema_js_1.channels)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channels.id, channelId), (0, drizzle_orm_1.eq)(schema_js_1.channels.tenantId, tenantId))).limit(1);
    if (!channel)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کانال'));
}
function view(row) {
    return {
        id: row.id,
        channelId: row.channelId,
        text: row.content,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
async function listSavedFooters(tenantId, channelId) {
    await requireOwnedChannel(tenantId, channelId);
    const rows = await (0, client_js_1.getDb)().select().from(schema_js_1.channelSavedFooters)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.channelId, channelId)))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.channelSavedFooters.createdAt), (0, drizzle_orm_1.asc)(schema_js_1.channelSavedFooters.id));
    return rows.map(view);
}
async function saveChannelFooter(tenantId, channelId, input) {
    await requireOwnedChannel(tenantId, channelId);
    const text = input.text.trim();
    if (!text || text.length > 500)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('متن انتهایی باید بین ۱ تا ۵۰۰ نویسه باشد.'));
    const db = (0, client_js_1.getDb)();
    const contentHash = (0, node_crypto_1.createHash)('sha256').update(text, 'utf8').digest('hex');
    const [existing] = await db.select().from(schema_js_1.channelSavedFooters).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.channelId, channelId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.contentHash, contentHash))).limit(1);
    if (existing) {
        if (existing.content !== text)
            throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
        await (0, audit_js_1.audit)({ action: 'channel.footer_library.reused', actorId: tenantId, subjectType: 'channel_saved_footer', subjectId: existing.id, meta: { channelId, length: text.length } });
        return view(existing);
    }
    const id = (0, ids_js_1.newId)();
    await db.insert(schema_js_1.channelSavedFooters).values({ id, tenantId, channelId, content: text, contentHash });
    await (0, audit_js_1.audit)({ action: 'channel.footer_library.created', actorId: tenantId, subjectType: 'channel_saved_footer', subjectId: id, meta: { channelId, length: text.length } });
    const [created] = await db.select().from(schema_js_1.channelSavedFooters).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.id, id), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.channelId, channelId))).limit(1);
    if (!created)
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    return view(created);
}
async function deleteSavedFooter(tenantId, channelId, footerId) {
    await requireOwnedChannel(tenantId, channelId);
    const db = (0, client_js_1.getDb)();
    const [footer] = await db.select({ id: schema_js_1.channelSavedFooters.id, content: schema_js_1.channelSavedFooters.content }).from(schema_js_1.channelSavedFooters).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.id, footerId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.channelId, channelId))).limit(1);
    if (!footer)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('متن انتهایی ذخیره‌شده'));
    await db.delete(schema_js_1.channelSavedFooters).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.id, footerId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedFooters.channelId, channelId)));
    await (0, audit_js_1.audit)({ action: 'channel.footer_library.deleted', actorId: tenantId, subjectType: 'channel_saved_footer', subjectId: footerId, meta: { channelId, length: footer.content.length } });
    return { id: footerId, deleted: true };
}
