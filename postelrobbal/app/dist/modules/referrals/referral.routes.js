"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerReferralRoutes = registerReferralRoutes;
const referral_service_js_1 = require("./referral.service.js");
const errors_js_1 = require("../../core/errors.js");
function auth(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return { id: req.user.id };
}
async function registerReferralRoutes(app) {
    app.get('/referrals/me', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        // Self-healing backfill: any REGISTER reward missed at registration time
        // (worker outage, etc.) is granted here; exactly-once by unique key.
        await (0, referral_service_js_1.awardRegisterReward)(me.id).catch(() => undefined);
        const summary = await (0, referral_service_js_1.myReferral)(me.id);
        return { success: true, data: summary };
    });
}
