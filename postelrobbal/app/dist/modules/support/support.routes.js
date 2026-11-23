"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSupportRoutes = registerSupportRoutes;
const zod_1 = require("zod");
const errors_js_1 = require("../../core/errors.js");
const permissions_js_1 = require("../../security/permissions.js");
const support_service_js_1 = require("./support.service.js");
const validation_js_1 = require("../../core/validation.js");
const media_service_js_1 = require("../media/media.service.js");
function auth(req) {
    if (!req.user)
        throw new errors_js_1.AppError(errors_js_1.ERR.AUTH_REQUIRED());
    return { id: req.user.id, role: req.user.role };
}
const createTicketSchema = zod_1.z.object({
    subject: zod_1.z.string().min(3).max(190),
    category: zod_1.z.string().min(1).max(80).optional(),
    body: zod_1.z.string().min(5).max(5000),
});
const messageSchema = zod_1.z.object({
    body: zod_1.z.string().min(1).max(5000),
});
// Ticket attachments (contract 14-contract item 7): images the media service
// can magic-byte-verify, plus PDF. ≤10MB (matches the multipart stream cap).
const ATTACHMENT_MIME_ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
function parse(schema, body) {
    return (0, validation_js_1.parseWith)(schema, body);
}
async function registerSupportRoutes(app) {
    app.get('/support/tickets', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const q = (req.query ?? {});
        const page = Number.parseInt(q.page ?? '1', 10) || 1;
        const pageSize = Number.parseInt(q.pageSize ?? '20', 10) || 20;
        const data = await (0, support_service_js_1.listTickets)(me.id, page, pageSize);
        return {
            success: true,
            data: { ...data, categories: await (0, support_service_js_1.getTicketCategories)() },
        };
    });
    app.post('/support/tickets', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        // Round 19: multipart "subject"+"category"+"body" (+ optional "file") so a
        // ticket can be opened with an attachment right away; JSON stays accepted.
        let subject = null;
        let category = null;
        let body = null;
        let file = null;
        if (req.isMultipart()) {
            for await (const part of req.parts()) {
                if (part.type === 'file') {
                    if (file)
                        continue; // one attachment per message — defensive
                    const mime = part.mimetype.toLowerCase();
                    if (!ATTACHMENT_MIME_ALLOWED.has(mime)) {
                        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('فرمت فایل مجاز نیست. تصویر (JPG، PNG، WebP، GIF) یا PDF ارسال کنید.'));
                    }
                    let buffer;
                    try {
                        buffer = await part.toBuffer();
                    }
                    catch {
                        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('حجم فایل بیش از حد مجاز است.'));
                    }
                    const fileName = (part.filename ?? 'file').trim().slice(0, 255) || 'file';
                    file = { buffer, mime, fileName };
                }
                else if (part.type === 'field') {
                    if (part.fieldname === 'subject' && typeof part.value === 'string')
                        subject = part.value;
                    else if (part.fieldname === 'category' && typeof part.value === 'string')
                        category = part.value;
                    else if (part.fieldname === 'body' && typeof part.value === 'string')
                        body = part.value;
                }
            }
            if (subject === null || subject.trim().length < 3 || body === null || body.trim().length < 5) {
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('موضوع و متن تیکت را کامل وارد کنید.'));
            }
        }
        else {
            const input = parse(createTicketSchema, req.body);
            subject = input.subject;
            category = input.category ?? 'GENERAL';
            body = input.body;
        }
        let attachment;
        if (file) {
            const uploaded = await (0, media_service_js_1.uploadMedia)(me.id, {
                buffer: file.buffer,
                mimeType: file.mime,
                maxBytes: ATTACHMENT_MAX_BYTES,
            });
            attachment = { mediaId: uploaded.id, fileName: file.fileName, sizeBytes: uploaded.sizeBytes, mime: uploaded.mime };
        }
        const data = await (0, support_service_js_1.createTicket)(me.id, me.id, { subject, category: category ?? 'GENERAL', body }, attachment);
        return { success: true, data };
    });
    app.get('/support/tickets/:id', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const { id } = req.params;
        const isSupport = (0, permissions_js_1.roleHasPermission)(me.role, 'support.tickets.any');
        const data = await (0, support_service_js_1.getTicket)(me.id, id, isSupport);
        return { success: true, data };
    });
    app.post('/support/tickets/:id/messages', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const { id } = req.params;
        // Multipart: "body" text field + optional "file" (image/*|pdf ≤10MB).
        // JSON {body} stays accepted so the current page keeps working until the
        // frontend upgrade ships.
        let body = null;
        let file = null;
        if (req.isMultipart()) {
            for await (const part of req.parts()) {
                if (part.type === 'file') {
                    if (file)
                        continue; // stream cap allows one file — defensive
                    const mime = part.mimetype.toLowerCase();
                    if (!ATTACHMENT_MIME_ALLOWED.has(mime)) {
                        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('فرمت فایل مجاز نیست. تصویر (JPG، PNG، WebP، GIF) یا PDF ارسال کنید.'));
                    }
                    let buffer;
                    try {
                        buffer = await part.toBuffer();
                    }
                    catch {
                        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('حجم فایل بیش از حد مجاز است.'));
                    }
                    const fileName = (part.filename ?? 'file').trim().slice(0, 255) || 'file';
                    file = { buffer, mime, fileName };
                }
                else if (part.fieldname === 'body' && typeof part.value === 'string') {
                    body = part.value;
                }
            }
            if (body === null || body.trim().length === 0) {
                throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('متن پیام را وارد کنید.'));
            }
        }
        else {
            const input = parse(messageSchema, req.body);
            body = input.body;
        }
        let attachment;
        if (file) {
            // uploadMedia re-validates size (≤10MB here) + magic bytes and stores
            // the bytes in the author's private tenant folder.
            const uploaded = await (0, media_service_js_1.uploadMedia)(me.id, {
                buffer: file.buffer,
                mimeType: file.mime,
                maxBytes: ATTACHMENT_MAX_BYTES,
            });
            attachment = { mediaId: uploaded.id, fileName: file.fileName, sizeBytes: uploaded.sizeBytes, mime: uploaded.mime };
        }
        const author = { id: me.id, role: me.role };
        const data = await (0, support_service_js_1.addTicketMessage)(me.id, id, author, body, attachment);
        return { success: true, data };
    });
    app.post('/support/tickets/:id/close', { preHandler: [app.requireAuth] }, async (req) => {
        const me = auth(req);
        const { id } = req.params;
        const actor = { id: me.id, role: me.role };
        await (0, support_service_js_1.closeTicket)(me.id, id, actor);
        return { success: true, data: { ok: true } };
    });
}
