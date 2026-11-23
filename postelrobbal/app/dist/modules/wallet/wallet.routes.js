"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWalletRoutes = registerWalletRoutes;
const zod_1 = require("zod");
const errors_js_1 = require("../../core/errors.js");
const wallet_service_js_1 = require("./wallet.service.js");
const validation_js_1 = require("../../core/validation.js");
function auth(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return { id: req.user.id };
}
const convertSchema = zod_1.z.object({
    points: zod_1.z.coerce.number().int().min(100).max(1_000_000),
});
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
async function registerWalletRoutes(app) {
    app.get('/wallet', { preHandler: [app.requireAuth] }, async (req) => {
        const summary = await (0, wallet_service_js_1.getWalletSummary)(auth(req).id);
        return { success: true, data: summary };
    });
    app.post('/wallet/convert-points', { preHandler: [app.requireAuth] }, async (req) => {
        const input = parse(convertSchema, req.body);
        const result = await (0, wallet_service_js_1.convertPoints)(auth(req).id, input.points);
        return { success: true, data: result };
    });
}
