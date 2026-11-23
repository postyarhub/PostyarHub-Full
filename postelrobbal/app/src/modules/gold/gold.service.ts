import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { channels, goldConfigs, goldSnapshots, outboxEvents, postTargets, posts } from '../../db/schema.js';
import { newId, sha256Hex } from '../../core/ids.js';
import { AppError, ERR } from '../../core/errors.js';
import { httpRaw, assertSafeUrl } from '../../core/http.js';
import { outboxRow } from '../../core/outbox.js';
import { getPlanContext } from '../subscriptions/plan.service.js';
import { getGoldSettings } from '../admin/system-settings.service.js';

/**
 * Gold ticker (§29): scheduled price scraping / API integration → tolerant parser → snapshot →
 * optional publish through the tenant's ACTIVE channels. Gated by the plan
 * feature gold_ticker. SSRF-guarded fetch on every run (§60) since sourceUrl
 * is user-influenced.
 * Supports Bearer API tokens (24tala.ir, Navasan, etc.) and fallback web-scraping.
 */

const DEFAULT_SOURCE_URL = 'https://www.tgju.org';
const DEFAULT_TEMPLATE =
  '🪙 نرخ لحظه‌ای طلا و سکه:\n\n' +
  'دلار: {دلار}\n' +
  'طلای ۱۸ عیار: {طلای ۱۸ عیار}\n' +
  'سکه امامی: {سکه امامی}\n\n' +
  ' توسط ربات پُست‌یار';

export interface GoldPrice {
  label: string;
  value: number;
}

export interface GoldConfigDto {
  id: string;
  tenantId: string;
  sourceUrl: string;
  apiToken: string | null;
  templateText: string;
  channelIds: string[];
  frequencyMinutes: number;
  timezone: string;
  changeOnly: boolean;
  isEnabled: boolean;
  lastSnapshot: unknown;
  lastRunAt: Date | null;
}

export interface GoldRunResult {
  configId: string;
  ok: boolean;
  changed: boolean;
  published: boolean;
  postId: string | null;
  prices: GoldPrice[];
  message: string | null;
}

export interface SaveGoldConfigInput {
  sourceUrl: string;
  apiToken?: string | null;
  templateText: string;
  channelIds: string[];
  frequencyMinutes: number;
  timezone: string;
  changeOnly: boolean;
  isEnabled: boolean;
}

async function requireGoldFeature(tenantId: string): Promise<void> {
  const ctx = await getPlanContext(tenantId);
  if (!ctx.features.gold_ticker) {
    throw new AppError({ ...ERR.FORBIDDEN(), message: 'ماژول طلا در پلن فعلی شما فعال نیست.' });
  }
}

function toDto(row: typeof goldConfigs.$inferSelect): GoldConfigDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    sourceUrl: row.sourceUrl,
    apiToken: row.apiToken ?? null,
    templateText: row.templateText,
    channelIds: Array.isArray(row.channelIds) ? row.channelIds : [],
    frequencyMinutes: row.frequencyMinutes,
    timezone: row.timezone,
    changeOnly: row.changeOnly === 1,
    isEnabled: row.isEnabled === 1,
    lastSnapshot: row.lastSnapshotJson ?? null,
    lastRunAt: row.lastRunAt,
  };
}

export async function getGoldConfig(tenantId: string): Promise<GoldConfigDto> {
  await requireGoldFeature(tenantId);
  const db = getDb();
  const [row] = await db.select().from(goldConfigs).where(eq(goldConfigs.tenantId, tenantId)).limit(1);
  if (row) return toDto(row); // existing rows keep their own values — unchanged behavior
  // Lazy default row so the settings form is immediately editable.
  // Round 18: the admin-configured defaults (system_settings key 'gold') win
  // when non-empty; otherwise the built-in constants below apply.
  let sourceUrl = DEFAULT_SOURCE_URL;
  let template = DEFAULT_TEMPLATE;
  let frequencyMinutes = 60;
  let apiToken: string | null = null;
  try {
    const admin = await getGoldSettings();
    if (admin.defaultSourceUrl !== '') sourceUrl = admin.defaultSourceUrl;
    if (admin.defaultTemplateFa !== '') template = admin.defaultTemplateFa;
    if (admin.apiToken !== '') apiToken = admin.apiToken;
    frequencyMinutes = admin.defaultFrequencyMinutes;
  } catch {
    // settings read failure → built-in defaults (never block the user form)
  }
  const id = newId();
  await db.insert(goldConfigs).values({
    id,
    tenantId,
    sourceUrl,
    apiToken,
    templateText: template,
    channelIds: [],
    frequencyMinutes,
    timezone: 'Asia/Tehran',
    changeOnly: 1,
    isEnabled: 0,
  });
  const [created] = await db.select().from(goldConfigs).where(eq(goldConfigs.tenantId, tenantId)).limit(1);
  if (!created) throw new AppError(ERR.INTERNAL());
  return toDto(created);
}

export async function saveGoldConfig(tenantId: string, input: SaveGoldConfigInput): Promise<GoldConfigDto> {
  await requireGoldFeature(tenantId);
  const db = getDb();

  if (input.frequencyMinutes < 15) {
    throw new AppError(ERR.VALIDATION('فاصلهٔ به‌روزرسانی نباید کمتر از ۱۵ دقیقه باشد.'));
  }
  // Save-time SSRF validation; the fetch re-validates on every run (DNS rebinding).
  await assertSafeUrl(input.sourceUrl);

  const uniqueChannelIds = [...new Set(input.channelIds)];
  if (uniqueChannelIds.length > 0) {
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.tenantId, tenantId), inArray(channels.id, uniqueChannelIds)));
    if (rows.length !== uniqueChannelIds.length) {
      throw new AppError(ERR.VALIDATION('یکی از کانال‌های انتخاب‌شده معتبر نیست.'));
    }
  }

  const [existing] = await db.select().from(goldConfigs).where(eq(goldConfigs.tenantId, tenantId)).limit(1);
  const values = {
    sourceUrl: input.sourceUrl,
    apiToken: input.apiToken !== undefined ? (input.apiToken ? input.apiToken.trim() : null) : undefined,
    templateText: input.templateText,
    channelIds: uniqueChannelIds,
    frequencyMinutes: input.frequencyMinutes,
    timezone: input.timezone || 'Asia/Tehran',
    changeOnly: input.changeOnly ? 1 : 0,
    isEnabled: input.isEnabled ? 1 : 0,
  };
  if (existing) {
    await db.update(goldConfigs).set(values).where(eq(goldConfigs.id, existing.id));
  } else {
    await db.insert(goldConfigs).values({ id: newId(), tenantId, ...values });
  }
  const [row] = await db.select().from(goldConfigs).where(eq(goldConfigs.tenantId, tenantId)).limit(1);
  if (!row) throw new AppError(ERR.INTERNAL());
  return toDto(row);
}

// ---- tolerant price parser & JSON API extractor -----------------------------

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function normalizeDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (d) => {
    const p = PERSIAN_DIGITS.indexOf(d);
    if (p >= 0) return String(p);
    return String(ARABIC_DIGITS.indexOf(d));
  });
}

/** Label detection rules — order matters (specific before generic). */
const LABEL_RULES: Array<{ re: RegExp; label: string }> = [
  { re: /سکه\s*امامی|طرح\s*جدید/, label: 'سکه امامی' },
  { re: /سکه\s*بهار|طرح\s*قدیم/, label: 'سکه بهار آزادی' },
  { re: /نیم\s*سکه|سکه\s*نیم/, label: 'نیم سکه' },
  { re: /ربع\s*سکه|سکه\s*ربع/, label: 'ربع سکه' },
  { re: /سکه\s*گرمی|گرمی/, label: 'سکه گرمی' },
  { re: /سکه/, label: 'سکه' },
  { re: /طلای\s*18|عِیار\s*18|عیار\s*18|18\s*عیار|گرمی\s*18|طلا18|طلا\s*18/, label: 'طلای ۱۸ عیار' },
  { re: /طلای\s*24|عیار\s*24|24\s*عیار/, label: 'طلای ۲۴ عیار' },
  { re: /انس\s*طلا|انس\s*جهانی|انس/, label: 'انس جهانی' },
  { re: /دلار|تتر|usdt|usd/i, label: 'دلار' },
  { re: /یورو|eur/i, label: 'یورو' },
  { re: /درهم|aed/i, label: 'درهم' },
  { re: /لیر|try/i, label: 'لیر' },
  { re: /پوند|gbp/i, label: 'پوند' },
  { re: /گرم\s*طلا|طلای\s*گرم/, label: 'طلای گرم' },
];

/** Standard English symbol to Persian label mapping (e.g. for 24tala, Navasan, etc.) */
const SYMBOL_TO_LABEL: Record<string, string> = {
  IR_GOLD_18K: 'طلای ۱۸ عیار',
  GOLD_18K: 'طلای ۱۸ عیار',
  GOLD_18: 'طلای ۱۸ عیار',
  GOLD18: 'طلای ۱۸ عیار',
  GERAM18: 'طلای ۱۸ عیار',
  TALA18: 'طلای ۱۸ عیار',
  TALA_18: 'طلای ۱۸ عیار',
  '18AYAR': 'طلای ۱۸ عیار',
  GOLD: 'طلای ۱۸ عیار',
  TALA: 'طلای ۱۸ عیار',
  IR_GOLD_24K: 'طلای ۲۴ عیار',
  GOLD_24K: 'طلای ۲۴ عیار',
  SEKE_EMAMI: 'سکه امامی',
  SEKEE: 'سکه امامی',
  EMAMI: 'سکه امامی',
  SEKE_BAHAR: 'سکه بهار آزادی',
  BAHAR: 'سکه بهار آزادی',
  SEKE_NIM: 'نیم سکه',
  NIM: 'نیم سکه',
  SEKE_ROB: 'ربع سکه',
  ROB: 'ربع سکه',
  SEKE_GERMI: 'سکه گرمی',
  GERMI: 'سکه گرمی',
  SEKE: 'سکه',
  USD: 'دلار',
  DOLLAR: 'دلار',
  USDT: 'تتر',
  EUR: 'یورو',
  EURO: 'یورو',
  AED: 'درهم',
  DIRHAM: 'درهم',
  TRY: 'لیر',
  LIRA: 'لیر',
  GBP: 'پوند',
  POUND: 'پوند',
  ONS: 'انس جهانی',
  OUNCE: 'انس جهانی',
  XAU: 'انس جهانی',
};

function matchLabelFromAny(keyOrName: string): string | null {
  if (!keyOrName || typeof keyOrName !== 'string') return null;
  const upper = keyOrName.trim().toUpperCase().replace(/[\s\-_]/g, '_');
  if (SYMBOL_TO_LABEL[upper]) return SYMBOL_TO_LABEL[upper];

  // Try direct Persian regex check
  const norm = normalizeDigits(keyOrName);
  const rule = LABEL_RULES.find((r) => r.re.test(norm));
  if (rule) return rule.label;

  // Substring matching for known identifiers
  for (const [sym, label] of Object.entries(SYMBOL_TO_LABEL)) {
    if (upper === sym || upper.includes(sym)) return label;
  }
  return null;
}

function extractNumber(line: string): number | null {
  const match = line.match(/(\d[\d,،٬./\s]*\d|\d)/);
  const captured = match?.[1];
  if (!captured) return null;
  let raw = captured.replace(/[\s,،٬]/g, '');
  if (raw.includes('/') && !raw.includes('.')) raw = raw.replace(/\//g, '.');
  const dots = (raw.match(/\./g) ?? []).length;
  if (dots > 1) {
    const parts = raw.split('.');
    const last = parts.pop() ?? '';
    raw = parts.join('') + (last.length <= 2 ? `.${last}` : last);
  } else if (dots === 1) {
    const [intPart, fracPart = ''] = raw.split('.');
    if (fracPart.length > 2) raw = intPart + fracPart; // likely a thousands dot
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseNumericValue(val: unknown): number | null {
  if (typeof val === 'number') {
    return Number.isFinite(val) && val > 0 ? val : null;
  }
  if (typeof val === 'string') {
    return extractNumber(normalizeDigits(val));
  }
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    for (const prop of ['price', 'value', 'val', 'current', 'p', 'rate', 'last', 'amount', 'sell', 'close']) {
      if (obj[prop] !== undefined) {
        const parsed = parseNumericValue(obj[prop]);
        if (parsed !== null) return parsed;
      }
    }
  }
  return null;
}

function extractPricesFromJson(data: unknown): GoldPrice[] {
  if (!data || typeof data !== 'object') return [];
  const out: GoldPrice[] = [];
  const seen = new Set<string>();

  const addPrice = (label: string | null, value: number | null) => {
    if (!label || value === null || value <= 0 || seen.has(label)) return;
    seen.add(label);
    out.push({ label, value });
  };

  let list: unknown[] | null = null;
  if (Array.isArray(data)) {
    list = data;
  } else {
    const obj = data as Record<string, unknown>;
    for (const key of ['rates', 'data', 'items', 'result', 'prices', 'list', 'currencies']) {
      if (Array.isArray(obj[key])) {
        list = obj[key] as unknown[];
        break;
      }
    }
  }

  if (list) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const candidate = String(row.symbol || row.name || row.title || row.label || row.key || row.id || row.slug || '');
      const label = matchLabelFromAny(candidate) || (row.name ? matchLabelFromAny(String(row.name)) : null);
      const value = parseNumericValue(row.price ?? row.value ?? row.val ?? row.current ?? row.rate ?? row.last ?? row);
      addPrice(label, value);
    }
  } else {
    const obj = (typeof (data as Record<string, unknown>).data === 'object' &&
      (data as Record<string, unknown>).data !== null &&
      !Array.isArray((data as Record<string, unknown>).data))
      ? ((data as Record<string, unknown>).data as Record<string, unknown>)
      : (data as Record<string, unknown>);

    for (const [key, val] of Object.entries(obj)) {
      const label = matchLabelFromAny(key);
      const value = parseNumericValue(val);
      addPrice(label, value);
    }
  }

  return out;
}

/** Tolerant parser: JSON API formats (24tala, etc.), Persian/Arabic digits, HTML scrape fallback. */
export function parseGoldPrices(input: string): GoldPrice[] {
  if (!input || typeof input !== 'string') return [];

  // 1. Try parsing structured JSON first (24tala.ir API v1/v2, etc.)
  const trimmed = input.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      const jsonPrices = extractPricesFromJson(parsed);
      if (jsonPrices.length > 0) {
        return jsonPrices;
      }
    } catch {
      // JSON parse error -> fall through to text/HTML parser
    }
  }

  // 2. HTML and plain-text fallback scraping
  const text = input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  const lines = normalizeDigits(text).split(/\r?\n|\u2028/);
  const out: GoldPrice[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const rule = LABEL_RULES.find((r) => r.re.test(line));
    if (!rule) continue;
    if (seen.has(rule.label)) continue;
    const value = extractNumber(line.replace(rule.re, ' '));
    if (value === null) continue;
    seen.add(rule.label);
    out.push({ label: rule.label, value });
    if (out.length >= 12) break;
  }
  return out;
}

function toPersianNumber(value: number): string {
  const formatted = Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return formatted.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d);
}

/** Replace {label} / {{label}} placeholders; unknown placeholders are removed. Supports common aliases. */
export function renderGoldTemplate(template: string, prices: GoldPrice[]): string {
  let out = template;
  for (const price of prices) {
    const formatted = toPersianNumber(price.value);
    out = out.split(`{{${price.label}}}`).join(formatted);
    out = out.split(`{${price.label}}`).join(formatted);

    // Support convenient shorthand template aliases
    if (price.label === 'طلای ۱۸ عیار') {
      out = out.split('{{طلای ۱۸}}').join(formatted);
      out = out.split('{طلای ۱۸}').join(formatted);
      out = out.split('{{طلا ۱۸}}').join(formatted);
      out = out.split('{طلا ۱۸}').join(formatted);
      out = out.split('{{طلا}}').join(formatted);
      out = out.split('{طلا}').join(formatted);
    } else if (price.label === 'سکه امامی') {
      out = out.split('{{سکه}}').join(formatted);
      out = out.split('{سکه}').join(formatted);
    }
  }
  return out.replace(/\{\{?[^{}\n]+\}?\}/g, '').trim();
}

// ---- run -------------------------------------------------------------------

export async function runGoldCheck(configId: string): Promise<GoldRunResult> {
  const db = getDb();
  const [config] = await db.select().from(goldConfigs).where(eq(goldConfigs.id, configId)).limit(1);
  if (!config) throw new AppError(ERR.NOT_FOUND('پیکربندی طلا'));

  const result: GoldRunResult = {
    configId,
    ok: false,
    changed: false,
    published: false,
    postId: null,
    prices: [],
    message: null,
  };

  try {
    let apiToken = config.apiToken?.trim() || '';
    if (!apiToken) {
      try {
        const admin = await getGoldSettings();
        if (admin.apiToken) apiToken = admin.apiToken.trim();
      } catch {
        // Fall back gracefully without admin token
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, text/html, text/plain, */*',
      'User-Agent': 'PostYar-GoldTicker/1.0 (+https://postyarhub.ir)',
    };
    if (apiToken) {
      headers.Authorization = apiToken.startsWith('Bearer ') ? apiToken : `Bearer ${apiToken}`;
    }

    const res = await httpRaw(config.sourceUrl, { ssrfGuard: true, timeoutMs: 15_000, headers });
    if (res.status >= 400) {
      result.message = `دریافت اطلاعات از منبع با خطای کد ${res.status} ناموفق بود.`;
      return result;
    }
    const prices = parseGoldPrices(res.body);
    if (prices.length === 0) {
      result.message = 'هیچ قیمتی از منبع استخراج نشد. لطفاً ساختار منبع یا توکن را بررسی کنید.';
      return result;
    }
    result.prices = prices;
    const contentHash = await sha256Hex(JSON.stringify(prices));

    // Serialize scheduler/manual executions on the gold config row.
    await db.transaction(async (tx) => {
      const [lockedConfig] = await tx
        .select()
        .from(goldConfigs)
        .where(eq(goldConfigs.id, configId))
        .limit(1)
        .for('update');
      if (!lockedConfig) throw new AppError(ERR.NOT_FOUND('پیکربندی طلا'));

      const [last] = await tx
        .select({ contentHash: goldSnapshots.contentHash })
        .from(goldSnapshots)
        .where(eq(goldSnapshots.configId, configId))
        .orderBy(desc(goldSnapshots.capturedAt))
        .limit(1);
      const changed = !last || last.contentHash !== contentHash;
      result.changed = changed;

      const willPublish =
        (changed || lockedConfig.changeOnly !== 1) && lockedConfig.isEnabled === 1 && lockedConfig.channelIds.length > 0;

      if (willPublish) {
        const activeChannels = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(
            and(
              eq(channels.tenantId, lockedConfig.tenantId),
              eq(channels.status, 'ACTIVE'),
              inArray(channels.id, lockedConfig.channelIds)
            )
          );
        if (activeChannels.length > 0) {
          const postId = newId();
          const body = renderGoldTemplate(lockedConfig.templateText, prices);
          await tx.insert(posts).values({
            id: postId,
            tenantId: lockedConfig.tenantId,
            title: 'نرخ لحظه‌ای طلا و سکه',
            body,
            parseMode: 'NONE',
            source: 'GOLD',
            state: 'QUEUED',
          });
          for (const channel of activeChannels) {
            await tx.insert(postTargets).values({
              id: newId(),
              postId,
              tenantId: lockedConfig.tenantId,
              channelId: channel.id,
              state: 'PENDING',
            });
          }
          await tx.insert(outboxEvents).values(
            outboxRow({ aggregateType: 'post', aggregateId: postId, eventType: 'post.publish', payload: {} })
          );
          result.published = true;
          result.postId = postId;
        }
      }

      await tx.insert(goldSnapshots).values({
        id: newId(),
        configId,
        pricesJson: prices,
        contentHash,
        published: result.published ? 1 : 0,
      });
      await tx
        .update(goldConfigs)
        .set({ lastRunAt: new Date(), lastSnapshotJson: prices })
        .where(eq(goldConfigs.id, configId));
    });

    result.ok = true;
    return result;
  } catch (err) {
    result.message = err instanceof AppError ? err.userMessage : 'بررسی نرخ طلا و سکه ناموفق بود.';
    await db
      .update(goldConfigs)
      .set({ lastRunAt: new Date() })
      .where(eq(goldConfigs.id, configId))
      .catch(() => undefined);
    return result;
  }
}

export async function runNow(tenantId: string): Promise<GoldRunResult> {
  const config = await getGoldConfig(tenantId);
  return runGoldCheck(config.id);
}
