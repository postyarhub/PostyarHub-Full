"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TICKET_CATEGORIES = void 0;
exports.getTicketCategories = getTicketCategories;
exports.putTicketCategories = putTicketCategories;
exports.listTickets = listTickets;
exports.createTicket = createTicket;
exports.getTicket = getTicket;
exports.addTicketMessage = addTicketMessage;
exports.closeTicket = closeTicket;
exports.adminListTickets = adminListTickets;
exports.adminGetTicket = adminGetTicket;
exports.adminAddTicketMessage = adminAddTicketMessage;
exports.adminCreateTicket = adminCreateTicket;
exports.adminCloseTicket = adminCloseTicket;
exports.listSupportTeam = listSupportTeam;
exports.createSupporter = createSupporter;
exports.setSupporterRole = setSupporterRole;
const drizzle_orm_1 = require("drizzle-orm");
const client_js_1 = require("../../db/client.js");
const schema_js_1 = require("../../db/schema.js");
const errors_js_1 = require("../../core/errors.js");
const ids_js_1 = require("../../core/ids.js");
const passwords_js_1 = require("../../security/passwords.js");
const delivery_js_1 = require("../notifications/delivery.js");
const email_notifications_js_1 = require("../notifications/email-notifications.js");
/** Built-in fallback used until the admin defines (or while none exist). */
exports.TICKET_CATEGORIES = [
    { key: 'GENERAL', labelFa: 'عمومی' },
    { key: 'BILLING', labelFa: 'مالی و اشتراک' },
    { key: 'TECHNICAL', labelFa: 'فنی و ارسال' },
    { key: 'BOT', labelFa: 'ربات و پاسخگوی خودکار' },
    { key: 'FEATURE', labelFa: 'درخواست امکان جدید' },
];
const CATEGORY_SETTINGS_KEY = 'ticket_categories';
const CATEGORY_KEY_RE = /^[A-Z0-9_]{2,40}$/;
/**
 * Round 19 — admin-defined ticket categories (system_settings key
 * 'ticket_categories', value { categories }). When nothing valid is stored the
 * built-in defaults apply, so both ticket paths behave exactly as before.
 */
async function getTicketCategories() {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({ valueJson: schema_js_1.systemSettings.valueJson })
        .from(schema_js_1.systemSettings)
        .where((0, drizzle_orm_1.eq)(schema_js_1.systemSettings.settingKey, CATEGORY_SETTINGS_KEY))
        .limit(1);
    const doc = row?.valueJson;
    const raw = doc?.categories;
    if (!Array.isArray(raw) || raw.length === 0)
        return exports.TICKET_CATEGORIES;
    const parsed = [];
    const seen = new Set();
    for (const item of raw) {
        if (typeof item !== 'object' || item === null)
            continue;
        const { key, labelFa } = item;
        if (typeof key !== 'string' || typeof labelFa !== 'string')
            continue;
        if (!CATEGORY_KEY_RE.test(key) || seen.has(key))
            continue;
        seen.add(key);
        parsed.push({ key, labelFa: labelFa.trim().slice(0, 60) || key });
    }
    return parsed.length > 0 ? parsed : exports.TICKET_CATEGORIES;
}
/** Validates + persists the category list authored in the admin panel. */
async function putTicketCategories(input) {
    if (!Array.isArray(input) || input.length === 0 || input.length > 20) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('فهرست دسته‌بندی‌ها باید بین ۱ تا ۲۰ مورد باشد.'));
    }
    const categories = [];
    const seen = new Set();
    for (const item of input) {
        if (typeof item !== 'object' || item === null) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('قالب دسته‌بندی معتبر نیست.'));
        }
        const { key, labelFa } = item;
        if (typeof key !== 'string' || !CATEGORY_KEY_RE.test(key)) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('کلید دسته‌بندی باید ۲ تا ۴۰ نویسهٔ لاتین بزرگ، رقم یا ـ باشد.'));
        }
        if (typeof labelFa !== 'string' || labelFa.trim().length < 2 || labelFa.trim().length > 60) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('عنوان فارسی دسته‌بندی باید ۲ تا ۶۰ نویسه باشد.'));
        }
        if (seen.has(key)) {
            throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION(`کلید «${key}» تکراری است.`));
        }
        seen.add(key);
        categories.push({ key, labelFa: labelFa.trim() });
    }
    const db = (0, client_js_1.getDb)();
    await db
        .insert(schema_js_1.systemSettings)
        .values({ settingKey: CATEGORY_SETTINGS_KEY, valueJson: { categories } })
        .onDuplicateKeyUpdate({ set: { valueJson: { categories } } });
    return categories;
}
async function listTickets(tenantId, page, pageSize) {
    const db = (0, client_js_1.getDb)();
    const p = Math.max(1, page);
    const size = Math.min(100, Math.max(1, pageSize));
    const [totalRow] = await db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_js_1.tickets).where((0, drizzle_orm_1.eq)(schema_js_1.tickets.tenantId, tenantId));
    const rows = await db
        .select()
        .from(schema_js_1.tickets)
        .where((0, drizzle_orm_1.eq)(schema_js_1.tickets.tenantId, tenantId))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.tickets.updatedAt))
        .limit(size)
        .offset((p - 1) * size);
    return { items: rows, total: Number(totalRow?.value ?? 0), page: p, pageSize: size };
}
/** Creates the ticket and its first message (optionally with one attachment) atomically. */
async function createTicket(tenantId, authorId, input, attachment) {
    const db = (0, client_js_1.getDb)();
    const categories = await getTicketCategories();
    const known = categories.some((c) => c.key === input.category);
    const category = known ? input.category : 'GENERAL';
    const id = (0, ids_js_1.newId)();
    const messageId = (0, ids_js_1.newId)();
    await db.transaction(async (tx) => {
        await tx.insert(schema_js_1.tickets).values({
            id,
            tenantId,
            subject: input.subject.trim().slice(0, 190),
            category,
            state: 'OPEN',
        });
        await tx.insert(schema_js_1.ticketMessages).values({
            id: messageId,
            ticketId: id,
            authorId,
            authorRole: 'USER',
            body: input.body.trim(),
        });
        if (attachment) {
            await tx.insert(schema_js_1.ticketMessageAttachments).values({
                id: (0, ids_js_1.newId)(),
                messageId,
                mediaId: attachment.mediaId,
                fileName: attachment.fileName.slice(0, 255),
                sizeBytes: attachment.sizeBytes,
                mime: attachment.mime,
            });
        }
    });
    await (0, email_notifications_js_1.notifyTicketEmail)({ kind: 'created', ticketId: id, messageId });
    return { id };
}
function attachmentDto(row) {
    return {
        id: row.mediaId,
        fileName: row.fileName,
        size: Number(row.sizeBytes),
        mime: row.mime,
        url: `/api/v1/media/${row.mediaId}`,
    };
}
/** Shared message mapping (user path + admin 360 path) — identical shape. */
async function fetchTicketMessages(ticketId) {
    const db = (0, client_js_1.getDb)();
    const messages = await db
        .select({
        id: schema_js_1.ticketMessages.id,
        authorRole: schema_js_1.ticketMessages.authorRole,
        authorId: schema_js_1.ticketMessages.authorId,
        body: schema_js_1.ticketMessages.body,
        createdAt: schema_js_1.ticketMessages.createdAt,
        attMediaId: schema_js_1.ticketMessageAttachments.mediaId,
        attFileName: schema_js_1.ticketMessageAttachments.fileName,
        attSizeBytes: schema_js_1.ticketMessageAttachments.sizeBytes,
        attMime: schema_js_1.ticketMessageAttachments.mime,
    })
        .from(schema_js_1.ticketMessages)
        .leftJoin(schema_js_1.ticketMessageAttachments, (0, drizzle_orm_1.eq)(schema_js_1.ticketMessageAttachments.messageId, schema_js_1.ticketMessages.id))
        .where((0, drizzle_orm_1.eq)(schema_js_1.ticketMessages.ticketId, ticketId))
        .orderBy(schema_js_1.ticketMessages.createdAt)
        .limit(200);
    return messages.map((m) => ({
        id: m.id,
        authorRole: m.authorRole,
        authorId: m.authorId,
        body: m.body,
        createdAt: m.createdAt,
        attachment: m.attMediaId && m.attFileName && m.attMime !== null
            ? attachmentDto({ mediaId: m.attMediaId, fileName: m.attFileName, sizeBytes: m.attSizeBytes ?? 0, mime: m.attMime })
            : null,
    }));
}
/** Ownership enforced here; support roles may open any ticket. */
async function getTicket(tenantId, ticketId, isSupport) {
    const db = (0, client_js_1.getDb)();
    const where = isSupport ? (0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticketId) : (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticketId), (0, drizzle_orm_1.eq)(schema_js_1.tickets.tenantId, tenantId));
    const [ticket] = await db.select().from(schema_js_1.tickets).where(where).limit(1);
    // Not-found for both missing and foreign tickets — no existence leak (§180).
    if (!ticket)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('تیکت'));
    return {
        ticket: {
            id: ticket.id,
            subject: ticket.subject,
            category: ticket.category,
            state: ticket.state,
            createdAt: ticket.createdAt,
            updatedAt: ticket.updatedAt,
        },
        messages: await fetchTicketMessages(ticket.id),
    };
}
/**
 * Role-aware reply (§145): USER reply reopens the ticket (OPEN);
 * SUPPORT/SUPER_ADMIN reply marks it ANSWERED.
 * Optional attachment (contract 14-contract item 7): media is uploaded by the
 * route via media.service; the attachment row is written in the same
 * transaction as the message (one attachment per message — uq_tatt_message).
 */
async function addTicketMessage(tenantId, ticketId, author, body, attachment) {
    const db = (0, client_js_1.getDb)();
    const isSupport = author.role !== 'USER';
    const where = isSupport ? (0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticketId) : (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticketId), (0, drizzle_orm_1.eq)(schema_js_1.tickets.tenantId, tenantId));
    const [ticket] = await db.select().from(schema_js_1.tickets).where(where).limit(1);
    if (!ticket)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('تیکت'));
    if (ticket.state === 'CLOSED' && !isSupport) {
        throw new errors_js_1.AppError(errors_js_1.ERR.CONFLICT('این تیکت بسته شده است. برای ادامه، تیکت جدیدی بسازید.'));
    }
    const nextState = isSupport ? 'ANSWERED' : 'OPEN';
    const messageId = (0, ids_js_1.newId)();
    await db.transaction(async (tx) => {
        await tx.insert(schema_js_1.ticketMessages).values({
            id: messageId,
            ticketId: ticket.id,
            authorId: author.id,
            authorRole: author.role,
            body: body.trim().slice(0, 5000),
        });
        if (attachment) {
            await tx.insert(schema_js_1.ticketMessageAttachments).values({
                id: (0, ids_js_1.newId)(),
                messageId,
                mediaId: attachment.mediaId,
                fileName: attachment.fileName.slice(0, 255),
                sizeBytes: attachment.sizeBytes,
                mime: attachment.mime,
            });
        }
        await tx.update(schema_js_1.tickets).set({ state: nextState }).where((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticket.id));
    });
    const message = {
        id: messageId,
        authorRole: author.role,
        authorId: author.id,
        body: body.trim().slice(0, 5000),
        createdAt: new Date(),
        attachment: attachment
            ? {
                id: attachment.mediaId,
                fileName: attachment.fileName.slice(0, 255),
                size: attachment.sizeBytes,
                mime: attachment.mime,
                url: `/api/v1/media/${attachment.mediaId}`,
            }
            : null,
    };
    await (0, email_notifications_js_1.notifyTicketEmail)({
        kind: isSupport ? 'staff-reply' : 'user-reply',
        ticketId: ticket.id,
        messageId,
    });
    return { state: nextState, message };
}
async function closeTicket(tenantId, ticketId, actor) {
    const db = (0, client_js_1.getDb)();
    const isSupport = actor.role !== 'USER';
    const where = isSupport ? (0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticketId) : (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticketId), (0, drizzle_orm_1.eq)(schema_js_1.tickets.tenantId, tenantId));
    const [ticket] = await db.select().from(schema_js_1.tickets).where(where).limit(1);
    if (!ticket)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('تیکت'));
    await db.update(schema_js_1.tickets).set({ state: 'CLOSED' }).where((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticket.id));
}
const toDate = (v) => {
    if (v instanceof Date)
        return v;
    if (typeof v === 'string' || typeof v === 'number') {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
};
const tenantNameOf = (firstName, lastName) => `${firstName ?? ''} ${lastName ?? ''}`.trim();
/** Admin ticket list: tenant join, search across subject/tenant, one grouped
 *  message-count query for the page ids (no N+1). Ordered by updatedAt desc. */
async function adminListTickets(opts) {
    const db = (0, client_js_1.getDb)();
    const p = Math.max(1, opts.page);
    const size = Math.min(100, Math.max(1, opts.pageSize));
    const term = opts.search?.trim();
    const like = term ? `%${term.replace(/[%_]/g, '')}%` : null;
    const where = (0, drizzle_orm_1.and)(opts.state ? (0, drizzle_orm_1.eq)(schema_js_1.tickets.state, opts.state) : undefined, like
        ? (0, drizzle_orm_1.or)((0, drizzle_orm_1.sql) `${schema_js_1.tickets.subject} LIKE ${like}`, (0, drizzle_orm_1.sql) `${schema_js_1.users.email} LIKE ${like}`, (0, drizzle_orm_1.sql) `${schema_js_1.users.firstName} LIKE ${like}`, (0, drizzle_orm_1.sql) `${schema_js_1.users.lastName} LIKE ${like}`)
        : undefined);
    const [totalRow] = await db
        .select({ value: (0, drizzle_orm_1.count)() })
        .from(schema_js_1.tickets)
        .innerJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.tickets.tenantId))
        .where(where);
    const rows = await db
        .select({
        id: schema_js_1.tickets.id,
        subject: schema_js_1.tickets.subject,
        category: schema_js_1.tickets.category,
        state: schema_js_1.tickets.state,
        createdAt: schema_js_1.tickets.createdAt,
        updatedAt: schema_js_1.tickets.updatedAt,
        tenantId: schema_js_1.tickets.tenantId,
        tenantFirstName: schema_js_1.users.firstName,
        tenantLastName: schema_js_1.users.lastName,
        tenantEmail: schema_js_1.users.email,
    })
        .from(schema_js_1.tickets)
        .innerJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.tickets.tenantId))
        .where(where)
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.tickets.updatedAt))
        .limit(size)
        .offset((p - 1) * size);
    // One grouped query for the page's ticket ids: COUNT + MAX(created_at).
    const ids = rows.map((r) => r.id);
    const msgRows = ids.length
        ? await db
            .select({
            ticketId: schema_js_1.ticketMessages.ticketId,
            cnt: (0, drizzle_orm_1.count)(),
            lastAt: (0, drizzle_orm_1.sql) `MAX(${schema_js_1.ticketMessages.createdAt})`,
        })
            .from(schema_js_1.ticketMessages)
            .where((0, drizzle_orm_1.inArray)(schema_js_1.ticketMessages.ticketId, ids))
            .groupBy(schema_js_1.ticketMessages.ticketId)
        : [];
    const msgByTicket = new Map(msgRows.map((m) => [m.ticketId, m]));
    return {
        items: rows.map((r) => ({
            id: r.id,
            subject: r.subject,
            category: r.category,
            state: r.state,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            tenantId: r.tenantId,
            tenantName: tenantNameOf(r.tenantFirstName, r.tenantLastName),
            tenantEmail: r.tenantEmail,
            messageCount: Number(msgByTicket.get(r.id)?.cnt ?? 0),
            lastMessageAt: toDate(msgByTicket.get(r.id)?.lastAt),
        })),
        total: Number(totalRow?.value ?? 0),
        page: p,
        pageSize: size,
    };
}
/** Admin detail view: ticket row + tenant identity + the SAME message shape
 *  as the user-path getTicket (attachments included). */
async function adminGetTicket(ticketId) {
    const db = (0, client_js_1.getDb)();
    const [row] = await db
        .select({
        id: schema_js_1.tickets.id,
        subject: schema_js_1.tickets.subject,
        category: schema_js_1.tickets.category,
        state: schema_js_1.tickets.state,
        createdAt: schema_js_1.tickets.createdAt,
        updatedAt: schema_js_1.tickets.updatedAt,
        tenantId: schema_js_1.tickets.tenantId,
        tenantFirstName: schema_js_1.users.firstName,
        tenantLastName: schema_js_1.users.lastName,
        tenantEmail: schema_js_1.users.email,
    })
        .from(schema_js_1.tickets)
        .innerJoin(schema_js_1.users, (0, drizzle_orm_1.eq)(schema_js_1.users.id, schema_js_1.tickets.tenantId))
        .where((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticketId))
        .limit(1);
    if (!row)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('تیکت'));
    const [msgAgg] = await db
        .select({
        cnt: (0, drizzle_orm_1.count)(),
        lastAt: (0, drizzle_orm_1.sql) `MAX(${schema_js_1.ticketMessages.createdAt})`,
    })
        .from(schema_js_1.ticketMessages)
        .where((0, drizzle_orm_1.eq)(schema_js_1.ticketMessages.ticketId, row.id));
    return {
        ticket: {
            id: row.id,
            subject: row.subject,
            category: row.category,
            state: row.state,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            tenantId: row.tenantId,
            tenantName: tenantNameOf(row.tenantFirstName, row.tenantLastName),
            tenantEmail: row.tenantEmail,
            messageCount: Number(msgAgg?.cnt ?? 0),
            lastMessageAt: toDate(msgAgg?.lastAt),
        },
        messages: await fetchTicketMessages(row.id),
    };
}
/**
 * Admin reply. Parity checks against the user-path addTicketMessage:
 *  - SUPPORT/SUPER_ADMIN reply marks the ticket ANSWERED (same as user flow);
 *  - authorRole is stored exactly as passed (SUPER_ADMIN stays SUPER_ADMIN);
 *  - round 19: optional attachment row written in the same transaction.
 */
async function adminAddTicketMessage(ticketId, actor, body, attachment) {
    const db = (0, client_js_1.getDb)();
    const [ticket] = await db.select().from(schema_js_1.tickets).where((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticketId)).limit(1);
    if (!ticket)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('تیکت'));
    if (ticket.state === 'CLOSED') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('تیکت بسته شده است و امکان ارسال پاسخ وجود ندارد.'));
    }
    const messageId = (0, ids_js_1.newId)();
    await db.transaction(async (tx) => {
        await tx.insert(schema_js_1.ticketMessages).values({
            id: messageId,
            ticketId: ticket.id,
            authorId: actor.id,
            authorRole: actor.role,
            body: body.trim().slice(0, 5000),
        });
        if (attachment) {
            await tx.insert(schema_js_1.ticketMessageAttachments).values({
                id: (0, ids_js_1.newId)(),
                messageId,
                mediaId: attachment.mediaId,
                fileName: attachment.fileName.slice(0, 255),
                sizeBytes: attachment.sizeBytes,
                mime: attachment.mime,
            });
        }
        // Explicit bump (the column also auto-updates on write) + ANSWERED state.
        await tx.update(schema_js_1.tickets).set({ state: 'ANSWERED', updatedAt: new Date() }).where((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticket.id));
    });
    await (0, email_notifications_js_1.notifyTicketEmail)({ kind: 'staff-reply', ticketId: ticket.id, messageId });
    return { ok: true };
}
/**
 * Round 19 — admin-initiated ticket (تیکت از سمت مدیر/پشتیبان): the staff
 * member picks a user and opens a conversation on their behalf. The first
 * message is authored by the staff role, so the ticket lands ANSWERED and the
 * user sees the staff's opening message immediately. The tenant is notified
 * in-app (unlike staff replies, without this the ticket is undiscoverable).
 */
async function adminCreateTicket(tenantId, actor, input, attachment) {
    const db = (0, client_js_1.getDb)();
    const [tenant] = await db.select({ id: schema_js_1.users.id }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, tenantId)).limit(1);
    if (!tenant)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کاربر'));
    const categories = await getTicketCategories();
    const known = categories.some((c) => c.key === input.category);
    const category = known ? input.category : 'GENERAL';
    const id = (0, ids_js_1.newId)();
    const messageId = (0, ids_js_1.newId)();
    await db.transaction(async (tx) => {
        await tx.insert(schema_js_1.tickets).values({
            id,
            tenantId,
            subject: input.subject.trim().slice(0, 190),
            category,
            state: 'ANSWERED', // staff authored the first message
        });
        await tx.insert(schema_js_1.ticketMessages).values({
            id: messageId,
            ticketId: id,
            authorId: actor.id,
            authorRole: actor.role,
            body: input.body.trim().slice(0, 5000),
        });
        if (attachment) {
            await tx.insert(schema_js_1.ticketMessageAttachments).values({
                id: (0, ids_js_1.newId)(),
                messageId,
                mediaId: attachment.mediaId,
                fileName: attachment.fileName.slice(0, 255),
                sizeBytes: attachment.sizeBytes,
                mime: attachment.mime,
            });
        }
    });
    await (0, delivery_js_1.notifyTenant)({
        tenantId,
        kind: 'TICKET_STAFF_CREATED',
        titleFa: 'تیکت جدید از سمت پشتیبانی',
        bodyFa: `تیکت «${input.subject.trim().slice(0, 120)}» توسط پشتیبانی برای شما ثبت شد و پیامی برایتان دارد.`,
    });
    await (0, email_notifications_js_1.notifyTicketEmail)({ kind: 'staff-created', ticketId: id, messageId });
    return { id };
}
/** Closes a ticket (idempotent: already-closed → no-op success); bumps updatedAt. */
async function adminCloseTicket(ticketId, _actor) {
    const db = (0, client_js_1.getDb)();
    const [ticket] = await db.select().from(schema_js_1.tickets).where((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticketId)).limit(1);
    if (!ticket)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('تیکت'));
    if (ticket.state !== 'CLOSED') {
        await db.update(schema_js_1.tickets).set({ state: 'CLOSED', updatedAt: new Date() }).where((0, drizzle_orm_1.eq)(schema_js_1.tickets.id, ticket.id));
    }
    return { ok: true };
}
// ---------------------------------------------------------------------------
// Round 19 — support team (پشتیبان‌ها): staff accounts with the SUPPORT role.
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MOBILE_RE = /^09\d{9}$/;
function normalizeMobile(m) {
    const fa = '۰۱۲۳۴۵۶۷۸۹';
    const ar = '٠١٢٣٤٥٦٧٨٩';
    const latin = m
        .replace(/[۰-۹]/g, (d) => String(fa.indexOf(d)))
        .replace(/[٠-٩]/g, (d) => String(ar.indexOf(d)))
        .replace(/[-\s()+]/g, '');
    if (latin.startsWith('+98'))
        return `0${latin.slice(3)}`;
    if (latin.startsWith('98') && latin.length === 12)
        return `0${latin.slice(2)}`;
    return latin;
}
/** Lists the support staff (role SUPPORT) with one grouped message count. */
async function listSupportTeam() {
    const db = (0, client_js_1.getDb)();
    const rows = await db
        .select({
        id: schema_js_1.users.id,
        firstName: schema_js_1.users.firstName,
        lastName: schema_js_1.users.lastName,
        email: schema_js_1.users.email,
        mobile: schema_js_1.users.mobile,
        status: schema_js_1.users.status,
        createdAt: schema_js_1.users.createdAt,
        lastLoginAt: schema_js_1.users.lastLoginAt,
    })
        .from(schema_js_1.users)
        .where((0, drizzle_orm_1.eq)(schema_js_1.users.role, 'SUPPORT'))
        .orderBy((0, drizzle_orm_1.desc)(schema_js_1.users.createdAt));
    const ids = rows.map((r) => r.id);
    const msgRows = ids.length
        ? await db
            .select({ authorId: schema_js_1.ticketMessages.authorId, value: (0, drizzle_orm_1.count)() })
            .from(schema_js_1.ticketMessages)
            .where((0, drizzle_orm_1.inArray)(schema_js_1.ticketMessages.authorId, ids))
            .groupBy(schema_js_1.ticketMessages.authorId)
        : [];
    const byAuthor = new Map(msgRows.map((m) => [m.authorId, Number(m.value)]));
    return rows.map((r) => ({ ...r, messagesCount: byAuthor.get(r.id) ?? 0 }));
}
/** Creates a new SUPPORT staff account (پشتیبان جدید). */
async function createSupporter(input) {
    const db = (0, client_js_1.getDb)();
    const firstName = input.firstName.trim();
    const lastName = input.lastName.trim();
    const email = input.email.trim().toLowerCase();
    const mobile = normalizeMobile(input.mobile);
    if (firstName.length < 2 || lastName.length < 2) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('نام و نام خانوادگی پشتیبان را کامل وارد کنید.'));
    }
    if (!EMAIL_RE.test(email))
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('ایمیل معتبر نیست.'));
    if (!MOBILE_RE.test(mobile))
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('شمارهٔ موبایل معتبر نیست (مثال: ۰۹۱۲۳۴۵۶۷۸۹).'));
    if (!(0, passwords_js_1.passwordPolicyOk)(input.password)) {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('گذرواژه ضعیف است؛ حداقل ۸ نویسه شامل حرف و رقم وارد کنید.'));
    }
    const passwordHash = await (0, passwords_js_1.hashPassword)(input.password);
    const id = (0, ids_js_1.newId)();
    try {
        await db.insert(schema_js_1.users).values({
            id,
            firstName: firstName.slice(0, 80),
            lastName: lastName.slice(0, 80),
            mobile,
            email,
            businessName: 'تیم پشتیبانی پُست‌یار',
            businessType: 'پشتیبانی',
            passwordHash,
            role: 'SUPPORT',
            status: 'ACTIVE',
        });
    }
    catch (err) {
        const msg = String(err.message ?? '');
        if (msg.includes('uq_users_email'))
            throw new errors_js_1.AppError(errors_js_1.ERR.DUPLICATE('این ایمیل'));
        if (msg.includes('uq_users_mobile'))
            throw new errors_js_1.AppError(errors_js_1.ERR.DUPLICATE('این شمارهٔ موبایل'));
        throw err;
    }
    return { id };
}
/** Promotes a USER to SUPPORT or demotes a SUPPORT back to USER. */
async function setSupporterRole(userId, role) {
    const db = (0, client_js_1.getDb)();
    const [user] = await db.select({ id: schema_js_1.users.id, role: schema_js_1.users.role }).from(schema_js_1.users).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId)).limit(1);
    if (!user)
        throw new errors_js_1.AppError(errors_js_1.ERR.NOT_FOUND('کاربر'));
    if (user.role === 'SUPER_ADMIN') {
        throw new errors_js_1.AppError(errors_js_1.ERR.VALIDATION('نقش مدیر ارشد قابل تغییر نیست.'));
    }
    if (user.role !== role) {
        await db.update(schema_js_1.users).set({ role }).where((0, drizzle_orm_1.eq)(schema_js_1.users.id, userId));
    }
}
