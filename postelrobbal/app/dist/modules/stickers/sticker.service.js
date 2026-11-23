"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILTIN_STICKER_CATALOG = void 0;
exports.listBuiltinStickerCatalog = listBuiltinStickerCatalog;
exports.listTelegramStickerSets = listTelegramStickerSets;
exports.listTelegramStickers = listTelegramStickers;
exports.importTelegramStickerSet = importTelegramStickerSet;
exports.fetchTelegramStickerFile = fetchTelegramStickerFile;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const ids_js_1 = require("../../core/ids.js");
const errors_js_1 = require("../../core/errors.js");
const http_js_1 = require("../../core/http.js");
const bot_service_js_1 = require("../bots/bot.service.js");
const encryption_js_1 = require("../../security/encryption.js");
const index_js_1 = require("../../providers/index.js");
exports.BUILTIN_STICKER_CATALOG = [
    { slug: 'chalughadamodionline_by_tgemodzibot', title: 'Chalughadamodionline', source: 'stickers.wiki', url: 'https://stickers.wiki/telegram-emojis/chalughadamodionline_by_tgemodzibot/', importable: true },
    { slug: 'changex_3', title: 'Change X 3', source: 'stickers.wiki', url: 'https://stickers.wiki/telegram-emojis/changex_3/', importable: true },
    { slug: 'cryptobundle', title: 'Crypto Bundle', source: 'stickers.wiki', url: 'https://stickers.wiki/telegram-emojis/cryptobundle/', importable: true },
    { slug: 'crazy_emoji_nakroshil_petrushki_by_e4zybot', title: 'Crazy Emoji', source: 'stickers.wiki', url: 'https://stickers.wiki/telegram-emojis/crazy_emoji_nakroshil_petrushki_by_e4zybot/', importable: true },
    { slug: 'rhymestg', title: 'Rhymes TG', source: 'stickers.wiki', url: 'https://stickers.wiki/telegram-emojis/rhymestg/', importable: true },
    { slug: '__source_emojipedia__', title: 'مخزن مرجع ایموجی Telegram', source: 'Emojipedia', url: 'https://emojipedia.org/telegram', importable: false },
    { slug: '__source_tgbot_collection__', title: 'ابزار دانلود مجموعه‌های Telegram', source: 'GitHub', url: 'https://github.com/tgbot-collection/stickers', importable: false },
    { slug: '__source_chpic__', title: 'کتابخانه CHPIC', source: 'CHPIC', url: 'https://chpic.su/', importable: false },
    { slug: '__source_stickers_wiki__', title: 'کاتالوگ کامل Stickers.wiki', source: 'Stickers.wiki', url: 'https://stickers.wiki/', importable: false },
];
function listBuiltinStickerCatalog() {
    return exports.BUILTIN_STICKER_CATALOG;
}
async function listTelegramStickerSets(tenantId) {
    const db = (0, client_js_1.getDb)();
    const sets = await db.select().from(schema_js_1.telegramStickerSets).where((0, drizzle_orm_1.eq)(schema_js_1.telegramStickerSets.tenantId, tenantId)).orderBy((0, drizzle_orm_1.desc)(schema_js_1.telegramStickerSets.updatedAt));
    return Promise.all(sets.map(async (set) => {
        const [preview] = await db.select({ id: schema_js_1.telegramStickers.id, emoji: schema_js_1.telegramStickers.emoji })
            .from(schema_js_1.telegramStickers)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.telegramStickers.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.telegramStickers.setId, set.id)))
            .orderBy((0, drizzle_orm_1.asc)(schema_js_1.telegramStickers.positionIndex))
            .limit(1);
        return { ...set, previewStickerId: preview?.id ?? null, previewEmoji: preview?.emoji ?? null };
    }));
}
async function listTelegramStickers(tenantId, setId) {
    const db = (0, client_js_1.getDb)();
    const [set] = await db.select().from(schema_js_1.telegramStickerSets).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.telegramStickerSets.id, setId), (0, drizzle_orm_1.eq)(schema_js_1.telegramStickerSets.tenantId, tenantId))).limit(1);
    if (!set)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('مجموعه استیکر'));
    const stickers = await db.select().from(schema_js_1.telegramStickers).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.telegramStickers.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.telegramStickers.setId, set.id))).orderBy((0, drizzle_orm_1.asc)(schema_js_1.telegramStickers.positionIndex));
    return { set, stickers };
}
async function importTelegramStickerSet(tenantId, botId, name) {
    const bot = await (0, bot_service_js_1.getOwnedBot)(tenantId, botId);
    if (bot.platform !== 'telegram')
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('برای دریافت استیکر، باید ربات تلگرام را انتخاب کنید.'));
    if (bot.status !== 'ACTIVE')
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ربات تلگرام فعال نیست.'));
    const stickerName = name.trim().replace(/^https?:\/\/t\.me\/(?:addstickers|addemoji)\//i, '').replace(/^@/, '').split(/[?#/]/)[0];
    if (!stickerName || !/^[A-Za-z0-9_\-]{2,255}$/.test(stickerName))
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('نام مجموعه استیکر تلگرام معتبر نیست.'));
    const provider = (0, index_js_1.getProvider)('telegram');
    const set = await provider.getStickerSet((0, encryption_js_1.decryptSecret)(bot.tokenEncrypted), stickerName);
    if (!set?.stickers?.length)
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('این مجموعه استیکر خالی است یا پیدا نشد.'));
    const db = (0, client_js_1.getDb)();
    const existing = await db.select({ id: schema_js_1.telegramStickerSets.id }).from(schema_js_1.telegramStickerSets).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.telegramStickerSets.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.telegramStickerSets.telegramName, set.name))).limit(1);
    const setId = existing[0]?.id ?? (0, ids_js_1.newId)();
    await db.insert(schema_js_1.telegramStickerSets).values({ id: setId, tenantId, botId, telegramName: set.name, title: set.title, stickerType: set.sticker_type }).onDuplicateKeyUpdate({ set: { botId, title: set.title, stickerType: set.sticker_type } });
    for (let i = 0; i < set.stickers.length; i++) {
        const sticker = set.stickers[i];
        await db.insert(schema_js_1.telegramStickers).values({ id: (0, ids_js_1.newId)(), tenantId, setId, fileId: sticker.file_id, fileUniqueId: sticker.file_unique_id, stickerType: sticker.type, emoji: sticker.emoji ?? null, width: sticker.width ?? null, height: sticker.height ?? null, isAnimated: sticker.is_animated ? 1 : 0, isVideo: sticker.is_video ? 1 : 0, thumbnailFileId: sticker.thumbnail?.file_id ?? null, customEmojiId: sticker.custom_emoji_id ?? null, positionIndex: i }).onDuplicateKeyUpdate({ set: { fileId: sticker.file_id, stickerType: sticker.type, emoji: sticker.emoji ?? null, width: sticker.width ?? null, height: sticker.height ?? null, isAnimated: sticker.is_animated ? 1 : 0, isVideo: sticker.is_video ? 1 : 0, thumbnailFileId: sticker.thumbnail?.file_id ?? null, customEmojiId: sticker.custom_emoji_id ?? null, positionIndex: i } });
    }
    return listTelegramStickers(tenantId, setId);
}
async function fetchTelegramStickerFile(tenantId, stickerId) {
    const db = (0, client_js_1.getDb)();
    const [sticker] = await db.select().from(schema_js_1.telegramStickers).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.telegramStickers.id, stickerId), (0, drizzle_orm_1.eq)(schema_js_1.telegramStickers.tenantId, tenantId))).limit(1);
    if (!sticker)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('استیکر'));
    const [set] = await db.select().from(schema_js_1.telegramStickerSets).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.telegramStickerSets.id, sticker.setId), (0, drizzle_orm_1.eq)(schema_js_1.telegramStickerSets.tenantId, tenantId))).limit(1);
    const botQuery = set?.botId
        ? db.select().from(schema_js_1.bots).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.id, set.botId), (0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, 'telegram'))).limit(1)
        : db.select().from(schema_js_1.bots).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.bots.tenantId, tenantId), (0, drizzle_orm_1.eq)(schema_js_1.bots.platform, 'telegram'), (0, drizzle_orm_1.eq)(schema_js_1.bots.status, 'ACTIVE'))).orderBy((0, drizzle_orm_1.desc)(schema_js_1.bots.updatedAt)).limit(1);
    const [bot] = await botQuery;
    if (!bot)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('ربات تلگرام مرتبط با این مجموعه'));
    const provider = (0, index_js_1.getProvider)('telegram');
    const token = (0, encryption_js_1.decryptSecret)(bot.tokenEncrypted);
    let file = await provider.getFile(token, sticker.fileId);
    if (!file.file_path)
        throw new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
    let targetType = 'main';
    const mainPath = String(file.file_path).toLowerCase();
    if ((sticker.isAnimated || mainPath.endsWith('.tgs')) && sticker.thumbnailFileId) {
        const thumbnail = await provider.getFile(token, sticker.thumbnailFileId);
        if (thumbnail.file_path) {
            file = thumbnail;
            targetType = 'thumbnail';
        }
    }
    const filePath = file.file_path;
    if (!filePath)
        throw new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
    const fetched = await (0, http_js_1.httpBuffer)(`https://api.telegram.org/file/bot${token}/${filePath}`, { timeoutMs: 15_000 });
    if (fetched.status < 200 || fetched.status >= 300)
        throw new errors_js_1.AppError(errors_js_1.ERR.PROVIDER_UNAVAILABLE());
    const buffer = fetched.body;
    const headerType = fetched.contentType?.split(';')[0]?.trim();
    const pathLower = filePath.toLowerCase();
    const contentType = targetType === 'thumbnail' ? (headerType?.startsWith('image/') ? headerType : 'image/webp') : (headerType || (pathLower.endsWith('.webm') || sticker.isVideo ? 'video/webm' : pathLower.endsWith('.tgs') || sticker.isAnimated ? 'application/x-tgsticker' : 'image/webp'));
    return { buffer, contentType, fileName: filePath.split('/').pop() || `${sticker.id}.${targetType === 'thumbnail' ? 'webp' : 'webm'}` };
}
