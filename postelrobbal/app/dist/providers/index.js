"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLATFORM_LABELS_FA = void 0;
exports.getProvider = getProvider;
const telegram_js_1 = require("./telegram/telegram.js");
const bale_js_1 = require("./bale/bale.js");
const rubika_js_1 = require("./rubika/rubika.js");
const adapters = {
    telegram: new telegram_js_1.TelegramAdapter(),
    bale: new bale_js_1.BaleAdapter(),
    rubika: new rubika_js_1.RubikaAdapter(),
};
function getProvider(platform) {
    return adapters[platform];
}
exports.PLATFORM_LABELS_FA = {
    telegram: 'تلگرام',
    bale: 'بله',
    rubika: 'روبیکا',
};
