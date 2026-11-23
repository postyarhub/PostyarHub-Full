"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveUniqueDeliveryButtons = resolveUniqueDeliveryButtons;
const button_target_js_1 = require("./button-target.js");
/**
 * Resolve persisted button shapes into provider-safe actions. For Telegram and
 * Bale posts, only URL buttons are forward-compatible: a legacy callback_data
 * or label-only button can cause the client to drop the entire keyboard when
 * the message is forwarded. Only HTTP(S) URL actions are retained for these
 * platforms. Rubika's native inline keypad supports callback actions and keeps
 * that behavior unchanged.
 */
function resolveUniqueDeliveryButtons(platform, candidates, limit = 8) {
    const resolved = [];
    const seenActions = new Set();
    const requireUrlForForwarding = platform === 'telegram' || platform === 'bale';
    for (const candidate of candidates) {
        const label = String(candidate.label ?? '').trim();
        const target = candidate.target;
        const rawUrl = typeof candidate.url === 'string' ? candidate.url.trim() : '';
        const rawCallback = typeof candidate.callback === 'string' ? candidate.callback.trim() : '';
        let url = '';
        let callback = '';
        if (target) {
            url = (0, button_target_js_1.resolveButtonTargetUrl)(platform, target);
        }
        else {
            if (rawUrl) {
                if (requireUrlForForwarding) {
                    try {
                        url = (0, button_target_js_1.normalizeButtonWebUrl)(rawUrl);
                    }
                    catch {
                        // Skip non-web legacy links (such as tel:) rather than letting
                        // one unsupported action suppress every valid URL button.
                        continue;
                    }
                }
                else {
                    url = (0, button_target_js_1.normalizeButtonWebUrl)(rawUrl);
                }
            }
            if (rawCallback)
                callback = rawCallback;
        }
        // Telegram may remove the whole inline keyboard from a forwarded copy if
        // any button uses callback_data instead of a URL. Bale uses the same Bot
        // API keyboard contract; apply the same URL-only rule there.
        if (requireUrlForForwarding) {
            if (!url)
                continue;
            let protocol = '';
            try {
                protocol = new URL(url).protocol;
            }
            catch {
                continue;
            }
            if (!['http:', 'https:'].includes(protocol))
                continue;
        }
        const actionKey = url ? `url:${url}` : `callback:${callback || label}`;
        if (seenActions.has(actionKey))
            continue;
        seenActions.add(actionKey);
        resolved.push({
            label,
            ...(url ? { url } : {}),
            ...(!url && callback ? { callback } : {}),
        });
    }
    return resolved.slice(0, Math.max(0, limit));
}
