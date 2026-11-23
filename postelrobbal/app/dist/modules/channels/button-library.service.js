"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listSavedButtons = listSavedButtons;
exports.saveChannelButton = saveChannelButton;
exports.deleteChannelButton = deleteChannelButton;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const errors_js_1 = require("../../core/errors.js");
const button_target_js_1 = require("../../core/button-target.js");
const audit_js_1 = require("../../core/audit.js");
function normalizeSavedTarget(target) {
    try {
        return { type: target.type, value: (0, button_target_js_1.normalizeButtonTargetValue)(target.type, target.value) };
    }
    catch {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('مقصد دکمه معتبر نیست. لینک باید http/https باشد و شماره یا شناسه نیز باید در قالب درست وارد شود.'));
    }
}
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
        label: row.label,
        target: { type: row.targetType, value: row.targetValue },
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
async function listSavedButtons(tenantId, channelId) {
    await requireOwnedChannel(tenantId, channelId);
    const rows = await (0, client_js_1.getDb)().select().from(schema_js_1.channelSavedButtons)
        .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.channelId, channelId)))
        .orderBy((0, drizzle_orm_1.asc)(schema_js_1.channelSavedButtons.label), (0, drizzle_orm_1.asc)(schema_js_1.channelSavedButtons.createdAt));
    return rows.map(view);
}
async function saveChannelButton(tenantId, channelId, input) {
    await requireOwnedChannel(tenantId, channelId);
    const label = input.label.trim();
    if (!label || label.length > 64)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('عنوان دکمه باید بین ۱ تا ۶۴ نویسه باشد.'));
    const target = normalizeSavedTarget(input.target);
    const db = (0, client_js_1.getDb)();
    const [existing] = await db.select().from(schema_js_1.channelSavedButtons).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.channelId, channelId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.label, label))).limit(1);
    if (existing) {
        await db.update(schema_js_1.channelSavedButtons).set({
            targetType: target.type,
            targetValue: target.value,
            updatedAt: new Date(),
        }).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.id, existing.id), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.channelId, channelId)));
        await (0, audit_js_1.audit)({ action: 'channel.button_library.updated', actorId: tenantId, subjectType: 'channel_saved_button', subjectId: existing.id, meta: { channelId, label } });
        const [updated] = await db.select().from(schema_js_1.channelSavedButtons).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.id, existing.id), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.tenantId, tenantId))).limit(1);
        if (!updated)
            throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
        return view(updated);
    }
    const id = (0, ids_js_1.newId)();
    await db.insert(schema_js_1.channelSavedButtons).values({
        id,
        tenantId,
        channelId,
        label,
        targetType: target.type,
        targetValue: target.value,
    });
    await (0, audit_js_1.audit)({ action: 'channel.button_library.created', actorId: tenantId, subjectType: 'channel_saved_button', subjectId: id, meta: { channelId, label } });
    const [created] = await db.select().from(schema_js_1.channelSavedButtons).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.id, id), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.tenantId, tenantId))).limit(1);
    if (!created)
        throw new errors_js_1.AppError(errors_js_1.ERR.INTERNAL());
    return view(created);
}
async function deleteChannelButton(tenantId, channelId, buttonId) {
    await requireOwnedChannel(tenantId, channelId);
    const db = (0, client_js_1.getDb)();
    const [button] = await db.select({ id: schema_js_1.channelSavedButtons.id, label: schema_js_1.channelSavedButtons.label }).from(schema_js_1.channelSavedButtons).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.id, buttonId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.channelId, channelId))).limit(1);
    if (!button)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('دکمهٔ ذخیره‌شده'));
    await db.delete(schema_js_1.channelSavedButtons).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.id, buttonId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.channelSavedButtons.channelId, channelId)));
    await (0, audit_js_1.audit)({ action: 'channel.button_library.deleted', actorId: tenantId, subjectType: 'channel_saved_button', subjectId: buttonId, meta: { channelId, label: button.label } });
    return { id: buttonId, deleted: true };
}
