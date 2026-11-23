"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerStickerRoutes = registerStickerRoutes;
const zod_1 = require("zod");
const errors_js_1 = require("../../core/errors.js");
const validation_js_1 = require("../../core/validation.js");
const sticker_service_js_1 = require("./sticker.service.js");
async function registerStickerRoutes(app) {
    app.get('/stickers/catalog', { preHandler: [app.requireAuth] }, async () => {
        return { success: true, data: { packs: (0, sticker_service_js_1.listBuiltinStickerCatalog)() } };
    });
    app.get('/stickers/telegram/sets', { preHandler: [app.requireAuth] }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const sets = await (0, sticker_service_js_1.listTelegramStickerSets)(user.id);
        return { success: true, data: { sets } };
    });
    app.get('/stickers/telegram/sets/:id', { preHandler: [app.requireAuth] }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const { id } = req.params;
        return { success: true, data: await (0, sticker_service_js_1.listTelegramStickers)(user.id, id) };
    });
    app.get('/stickers/telegram/:id/file', { preHandler: [app.requireAuth] }, async (req, reply) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const { id } = req.params;
        const file = await (0, sticker_service_js_1.fetchTelegramStickerFile)(user.id, id);
        reply.header('Content-Type', file.contentType).header('Cache-Control', 'private, max-age=86400').header('Content-Disposition', `inline; filename=\"${file.fileName.replace(/\"/g, '')}\"`);
        return reply.send(file.buffer);
    });
    app.post('/stickers/telegram/import', { preHandler: [app.requireAuth] }, async (req) => {
        const user = req.user;
        if (!user)
            throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
        const input = (0, validation_js_1.parseWith)(zod_1.z.object({ botId: zod_1.z.string().min(10).max(26), setName: zod_1.z.string().min(2).max(255) }).strict(), req.body);
        const result = await (0, sticker_service_js_1.importTelegramStickerSet)(user.id, input.botId, input.setName);
        return { success: true, data: result };
    });
}
