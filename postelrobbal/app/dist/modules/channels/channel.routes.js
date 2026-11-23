"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerChannelRoutes = registerChannelRoutes;
const zod_1 = require("zod");
const errors_js_1 = require("../../core/errors.js");
const validation_js_1 = require("../../core/validation.js");
const index_js_1 = require("../../providers/index.js");
const button_library_service_js_1 = require("./button-library.service.js");
const footer_library_service_js_1 = require("./footer-library.service.js");
const channel_service_js_1 = require("./channel.service.js");
const PLATFORMS = ['telegram', 'bale', 'rubika'];
function parsePlatform(value) {
    if (typeof value === 'string' && PLATFORMS.includes(value)) {
        return value;
    }
    throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('پلتفرم باید یکی از موارد telegram، bale یا rubika باشد.'));
}
function actor(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return { tenantId: req.user.id, actorId: req.user.id, actorRole: req.user.role, ip: req.ip };
}
const connectSchema = zod_1.z.object({
    platform: zod_1.z.enum(['telegram', 'bale', 'rubika']),
    channelRef: zod_1.z.string().min(2).max(190),
    title: zod_1.z.string().min(1).max(190),
    botId: zod_1.z.string().min(10).max(26).optional(),
});
const updateSchema = zod_1.z.object({ title: zod_1.z.string().min(1).max(190), botId: zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/).nullable().optional() }).strict();
const channelIdSchema = zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/);
const savedButtonTargetSchema = zod_1.z.discriminatedUnion('type', [
    zod_1.z.object({ type: zod_1.z.literal('URL'), value: zod_1.z.string().trim().min(1).max(255) }).strict(),
    zod_1.z.object({ type: zod_1.z.literal('PHONE'), value: zod_1.z.string().trim().min(1).max(32) }).strict(),
    zod_1.z.object({ type: zod_1.z.literal('TELEGRAM_ID'), value: zod_1.z.string().trim().min(1).max(190) }).strict(),
    zod_1.z.object({ type: zod_1.z.literal('BALE_ID'), value: zod_1.z.string().trim().min(1).max(190) }).strict(),
    zod_1.z.object({ type: zod_1.z.literal('RUBIKA_ID'), value: zod_1.z.string().trim().min(1).max(190) }).strict(),
]);
const saveButtonSchema = zod_1.z.object({
    label: zod_1.z.string().trim().min(1).max(64),
    target: savedButtonTargetSchema,
}).strict();
const saveFooterSchema = zod_1.z.object({
    text: zod_1.z.string().trim().min(1).max(500),
}).strict();
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
async function registerChannelRoutes(app) {
    app.get('/channels', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const channels = await (0, channel_service_js_1.listChannels)(tenantId);
        return { success: true, data: { channels } };
    });
    app.post('/channels', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId, ...meta } = actor(req);
        const input = parse(connectSchema, req.body);
        const channel = await (0, channel_service_js_1.connectChannel)(tenantId, input, meta);
        return { success: true, data: { channel } };
    });
    app.post('/channels/rubika/discovery', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const input = parse(zod_1.z.object({ botId: zod_1.z.string().regex(/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/), publicRef: zod_1.z.string().max(190).optional(), title: zod_1.z.string().max(190).optional() }).strict(), req.body);
        const discovery = await (0, channel_service_js_1.startRubikaChannelDiscovery)(tenantId, input);
        return { success: true, data: { discovery } };
    });
    app.get('/channels/rubika/discovery/:id', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const id = parse(zod_1.z.string().min(12).max(64), req.params.id);
        const discovery = await (0, channel_service_js_1.getRubikaChannelDiscovery)(tenantId, id);
        return { success: true, data: { discovery } };
    });
    // Static path before /channels/:id-style routes — capabilities for the UI.
    app.get('/channels/capabilities', { preHandler: [app.requireAuth] }, async (req) => {
        const query = (req.query ?? {});
        const platform = parsePlatform(query.platform);
        return { success: true, data: { platform, capabilities: (0, index_js_1.getProvider)(platform).capabilities() } };
    });
    app.get('/channels/:id/saved-buttons', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const id = parse(channelIdSchema, req.params.id);
        const buttons = await (0, button_library_service_js_1.listSavedButtons)(tenantId, id);
        return { success: true, data: { buttons } };
    });
    app.post('/channels/:id/saved-buttons', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const id = parse(channelIdSchema, req.params.id);
        const input = parse(saveButtonSchema, req.body);
        const button = await (0, button_library_service_js_1.saveChannelButton)(tenantId, id, input);
        return { success: true, data: { button } };
    });
    app.delete('/channels/:id/saved-buttons/:buttonId', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const params = req.params;
        const channelId = parse(channelIdSchema, params.id);
        const buttonId = parse(channelIdSchema, params.buttonId);
        const result = await (0, button_library_service_js_1.deleteChannelButton)(tenantId, channelId, buttonId);
        return { success: true, data: result };
    });
    app.get('/channels/:id/saved-footers', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const id = parse(channelIdSchema, req.params.id);
        const footers = await (0, footer_library_service_js_1.listSavedFooters)(tenantId, id);
        return { success: true, data: { footers } };
    });
    app.post('/channels/:id/saved-footers', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const id = parse(channelIdSchema, req.params.id);
        const input = parse(saveFooterSchema, req.body);
        const footer = await (0, footer_library_service_js_1.saveChannelFooter)(tenantId, id, input);
        return { success: true, data: { footer } };
    });
    app.delete('/channels/:id/saved-footers/:footerId', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId } = actor(req);
        const params = req.params;
        const channelId = parse(channelIdSchema, params.id);
        const footerId = parse(channelIdSchema, params.footerId);
        const result = await (0, footer_library_service_js_1.deleteSavedFooter)(tenantId, channelId, footerId);
        return { success: true, data: result };
    });
    app.post('/channels/:id/verify', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId, ...meta } = actor(req);
        const { id } = req.params;
        const channel = await (0, channel_service_js_1.verifyChannel)(tenantId, id, meta);
        return { success: true, data: { channel } };
    });
    const update = async (req) => {
        const { tenantId, ...meta } = actor(req);
        const { id } = req.params;
        const input = parse(updateSchema, req.body);
        const channel = await (0, channel_service_js_1.updateChannel)(tenantId, id, input, meta);
        return { success: true, data: { channel } };
    };
    app.patch('/channels/:id', { preHandler: [app.requireAuth] }, update);
    app.post('/channels/:id', { preHandler: [app.requireAuth] }, update);
    app.delete('/channels/:id', { preHandler: [app.requireAuth] }, async (req) => {
        const { tenantId, ...meta } = actor(req);
        const { id } = req.params;
        const channel = await (0, channel_service_js_1.disconnectChannel)(tenantId, id, meta);
        return { success: true, data: { channel } };
    });
}
