"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const sharp_1 = __importDefault(require("sharp"));
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const media_service_js_1 = require("./media.service.js");
let tempDir = '';
(0, vitest_1.beforeEach)(async () => {
    tempDir = await node_fs_1.promises.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), 'postyar-media-'));
    process.env.STORAGE_DIR = tempDir;
});
(0, vitest_1.afterEach)(async () => {
    delete process.env.STORAGE_DIR;
    if (tempDir)
        await node_fs_1.promises.rm(tempDir, { recursive: true, force: true });
});
(0, vitest_1.describe)('provider photo representation', () => {
    (0, vitest_1.it)('converts an image to JPEG only at provider-delivery time', async () => {
        const png = await (0, sharp_1.default)({
            create: { width: 20, height: 12, channels: 3, background: { r: 255, g: 0, b: 0 } },
        }).png().toBuffer();
        const relative = 'tenant/source.webp';
        await node_fs_1.promises.mkdir(node_path_1.default.join(tempDir, 'tenant'), { recursive: true });
        await node_fs_1.promises.writeFile(node_path_1.default.join(tempDir, relative), png);
        const jpeg = await (0, media_service_js_1.readProviderPhotoJpeg)({
            id: '01J00000000000000000000000',
            tenantId: '01J00000000000000000000000',
            filename: 'source.webp',
            mime: 'image/webp',
            sizeBytes: png.length,
            width: 20,
            height: 12,
            checksum: 'x'.repeat(64),
            storagePath: relative,
            createdAt: new Date(),
        });
        const meta = await (0, sharp_1.default)(jpeg).metadata();
        (0, vitest_1.expect)(meta.format).toBe('jpeg');
        (0, vitest_1.expect)(meta.width).toBe(20);
        (0, vitest_1.expect)(meta.height).toBe(12);
    });
});
