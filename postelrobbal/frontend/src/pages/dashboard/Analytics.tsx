import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiRequestError } from '../../lib/api';
import { Badge, Card, EmptyState, PageLoading } from '../../components/ui';
import { faDateShort, faMoney, faNumber, faRelative, PLATFORM_FA } from '../../lib/format';
import { PlatformIcon } from '../../pages/admin/shared';

type PlatformKey = 'telegram' | 'bale' | 'rubika' | 'wordpress';

interface SummaryDto {
  days: number;
  from: string;
  to: string;
  events: { total: number; sent: number; failed: number };
  successRate: number | null;
  platforms: Record<PlatformKey, { sent: number; failed: number }>;
  daily: Array<{ day: string; eventName: string; count: number }>;
  topPosts: Array<{ id: string; title: string | null; events: number }>;
  topCampaigns: Array<{ id: string; name: string; events: number }>;
  errors: Array<{ eventType: string; count: number }>;
  links: { clicks: number };
  revenue: {
    paymentsCompleted: number;
    paymentsCompletedRial: number;
    subscriptionRevenueRial: number;
    walletTopupRial: number;
    paymentsFailed: number;
    subscriptionsCreated: number;
    subscriptionsRenewed: number;
    subscriptionsExpired: number;
    referralsCreated: number;
    referralRewardEvents: number;
    referralRewardPoints: number;
  };
  automation: {
    ai: {
      requested: number;
      completed: number;
      failed: number;
      successRate: number | null;
      tokens: number;
      avgDurationMs: number | null;
    };
    workflows: {
      started: number;
      completed: number;
      failed: number;
      successRate: number | null;
      avgDurationMs: number | null;
    };
    errors: Array<{
      eventType: string;
      errorCode: string;
      count: number;
    }>;
  };
}

interface EventsDto {
  events: Array<{
    id: string;
    name: string;
    subjectType: string | null;
    subjectId: string | null;
    props?: Record<string, unknown> | null;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

interface TargetDto {
  platform: string;
  channelTitle: string;
  channelRef: string;
  state: string;
  attempts: number;
  errorCode: string | null;
}

interface PostDetails {
  post: { title: string | null };
  targets: TargetDto[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isSummaryDto(value: unknown): value is SummaryDto {
  if (!isRecord(value)) return false;

  const events = value.events;
  const platforms = value.platforms;
  const links = value.links;
  const revenue = value.revenue;
  const automation = value.automation;
  if (!isRecord(events) || !isRecord(platforms) || !isRecord(links) ||
      !isRecord(revenue) || !isRecord(automation)) return false;

  const aiValue = automation.ai;
  const workflowsValue = automation.workflows;
  const automationErrors = automation.errors;
  if (!isRecord(aiValue) || !isRecord(workflowsValue) || !Array.isArray(automationErrors)) return false;

  const revenueFields = [
    'paymentsCompleted', 'paymentsCompletedRial', 'subscriptionRevenueRial', 'walletTopupRial',
    'paymentsFailed', 'subscriptionsCreated', 'subscriptionsRenewed', 'subscriptionsExpired',
    'referralsCreated', 'referralRewardEvents', 'referralRewardPoints',
  ];
  const ai = aiValue;
  const workflows = workflowsValue;
  const platformKeys: PlatformKey[] = ['telegram', 'bale', 'rubika', 'wordpress'];

  return isFiniteNumber(value.days) && typeof value.from === 'string' && typeof value.to === 'string' &&
    isFiniteNumber(events.total) && isFiniteNumber(events.sent) && isFiniteNumber(events.failed) &&
    isNullableNumber(value.successRate) && Array.isArray(value.daily) &&
    value.daily.every((row) => isRecord(row) && typeof row.day === 'string' && typeof row.eventName === 'string' && isFiniteNumber(row.count)) &&
    platformKeys.every((key) => {
      const platform = platforms[key];
      return isRecord(platform) && isFiniteNumber(platform.sent) && isFiniteNumber(platform.failed);
    }) &&
    Array.isArray(value.topPosts) && value.topPosts.every((row) => isRecord(row) && typeof row.id === 'string' && (typeof row.title === 'string' || row.title === null) && isFiniteNumber(row.events)) &&
    Array.isArray(value.topCampaigns) && value.topCampaigns.every((row) => isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string' && isFiniteNumber(row.events)) &&
    Array.isArray(value.errors) && value.errors.every((row) => isRecord(row) && typeof row.eventType === 'string' && isFiniteNumber(row.count)) &&
    isFiniteNumber(links.clicks) && revenueFields.every((key) => isFiniteNumber(revenue[key])) &&
    isFiniteNumber(ai.requested) && isFiniteNumber(ai.completed) && isFiniteNumber(ai.failed) && isNullableNumber(ai.successRate) &&
    isFiniteNumber(ai.tokens) && isNullableNumber(ai.avgDurationMs) &&
    isFiniteNumber(workflows.started) && isFiniteNumber(workflows.completed) && isFiniteNumber(workflows.failed) &&
    isNullableNumber(workflows.successRate) && isNullableNumber(workflows.avgDurationMs) &&
    automationErrors.every((row) => isRecord(row) && typeof row.eventType === 'string' && typeof row.errorCode === 'string' && isFiniteNumber(row.count));
}

function isEventsDto(value: unknown): value is EventsDto {
  return isRecord(value) && Array.isArray(value.events) &&
    value.events.every((row) => isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string' &&
      (typeof row.subjectType === 'string' || row.subjectType === null) && (typeof row.subjectId === 'string' || row.subjectId === null) && typeof row.createdAt === 'string') &&
    (typeof value.nextCursor === 'string' || value.nextCursor === null);
}

async function getRecentActivity(): Promise<unknown> {
  try {
    return await api.get<unknown>('/api/v1/analytics/recent-activity?limit=24');
  } catch (error) {
    if (error instanceof ApiRequestError && (error.code === 'NOT_FOUND' || error.code === 'NETWORK_ERROR')) {
      return api.get<unknown>('/api/v1/analytics/events?limit=24');
    }
    throw error;
  }
}

function analyticsErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof TypeError) return 'دریافت اطلاعات تحلیل به دلیل خطای ارتباط یا پاسخ نامعتبر انجام نشد. دوباره تلاش کنید.';
  return 'دریافت اطلاعات تحلیل با خطای پیش‌بینی‌نشده روبه‌رو شد. دوباره تلاش کنید.';
}

const EVENT_FA: Record<string, string> = {
  'post.created': 'ایجاد پست',
  'post.scheduled': 'زمان‌بندی پست',
  'post.sent': 'ارسال موفق',
  'post.failed': 'خطای ارسال',
  'post.delivery.sent': 'تحویل موفق',
  'post.delivery.failed': 'خطای تحویل',
  'bot.created': 'افزودن ربات',
  'bot.enabled': 'فعال‌سازی ربات',
  'bot.disabled': 'غیرفعال‌سازی ربات',
  'channel.connected': 'اتصال کانال',
  'channel.disconnected': 'قطع اتصال کانال',
  'payment.created': 'ایجاد پرداخت',
  'payment.initiated': 'آغاز پرداخت',
  'payment.completed': 'پرداخت موفق',
  'payment.failed': 'پرداخت ناموفق',
  'subscription.created': 'خرید اشتراک',
  'subscription.renewed': 'تمدید اشتراک',
  'subscription.expiring': 'نزدیک به پایان اشتراک',
  'subscription.expired': 'پایان اشتراک',
  'referral.rewarded': 'پاداش معرفی',
  'wordpress.connected': 'اتصال وردپرس',
  'wordpress.sync.completed': 'تکمیل همگام‌سازی وردپرس',
  'wordpress.sync.failed': 'خطای همگام‌سازی وردپرس',
  'wordpress.product.published': 'انتشار محصول',
  'ai.requested': 'درخواست هوش مصنوعی',
  'ai.completed': 'پردازش هوش مصنوعی',
  'ai.failed': 'خطای هوش مصنوعی',
  'workflow.started': 'شروع گردش‌کار',
  'workflow.completed': 'تکمیل گردش‌کار',
  'workflow.failed': 'خطای گردش‌کار',
  'user.login': 'ورود به حساب',
  'user.registration': 'ثبت‌نام',
  'user.logout': 'خروج از حساب',
  'channel.created': 'ایجاد کانال',
  'channel.updated': 'به‌روزرسانی کانال',
  'post.delivery.started': 'آغاز ارسال به مقصد',
  'bot.message.received': 'دریافت پیام ربات',
  'bot.message.sent': 'ارسال پیام ربات',
  'bot.button.clicked': 'فشردن دکمه ربات',
  'wordpress.product.synced': 'همگام‌سازی محصول',
  'wordpress.content.published': 'انتشار محتوا در وردپرس',
  'wordpress.campaign.created': 'ایجاد کارزار وردپرس',
  'wordpress.campaign.updated': 'به‌روزرسانی کارزار وردپرس',
  'wordpress.campaign.deleted': 'حذف کارزار وردپرس',
  'wordpress.campaign.run.started': 'آغاز اجرای کارزار',
  'wordpress.campaign.run.completed': 'پایان موفق اجرای کارزار',
  'wordpress.campaign.run.failed': 'ناموفق بودن اجرای کارزار',
  'wordpress.product.failed': 'خطای پردازش محصول وردپرس',
  'wordpress.content.failed': 'خطای انتشار محتوا در وردپرس',
  'link.clicked': 'باز کردن پیوند',
  'wallet.credit': 'افزایش موجودی کیف پول',
  'wallet.debit': 'کاهش موجودی کیف پول',
  'referral.created': 'ثبت معرفی',
};

function eventLabel(name: string): string {
  return EVENT_FA[name] ?? 'سایر فعالیت‌ها';
}

const ERROR_FA: Record<string, { label: string; action: string }> = {
  NOT_FOUND: {
    label: 'مقصد پیدا نشد',
    action: 'شناسه کانال یا شناسه عددی چت و عضویت ربات را بررسی کنید.',
  },
  TRANSIENT: {
    label: 'اختلال موقت در اتصال شبکه',
    action: 'سیستم به صورت خودکار دوباره تلاش خواهد کرد؛ اتصال سرور یا پلتفرم را بررسی نمایید.',
  },
  BLOCKED: {
    label: 'دسترسی ادمین ناکافی',
    action: 'سطح دسترسی ربات را در کانال، گروه یا پیج مقصد روی دسترسی ارسال پیام و رسانه تنظیم کنید.',
  },
  UNAUTHORIZED: {
    label: 'اعتبار توکن نامعتبر',
    action: 'توکن ربات یا کلید اتصال در بخش تنظیمات پلتفرم منقضی یا بازنشانی شده است.',
  },
  CHANNEL_DISABLED: {
    label: 'کانال غیرفعال است',
    action: 'وضعیت فعال بودن کانال در پیشخوان پست‌یار را مجدداً بررسی کنید.',
  },
  PROVIDER_UNAVAILABLE: {
    label: 'پلتفرم موقتاً در دسترس نیست',
    action: 'سرویس‌دهنده پیام‌رسان با افت مقطعی روبه‌روست؛ تلاش مجدد به‌زودی انجام خواهد شد.',
  },
  RATE_LIMITED: {
    label: 'محدودیت نرخ ارسال (Rate Limit)',
    action: 'سرعت ارسال پیام‌ها را کاهش داده و فاصله زمانی بین پست‌ها را افزایش دهید.',
  },
  VALIDATION: {
    label: 'داده یا فرمت پیام نامعتبر',
    action: 'متن، هشتگ‌ها، فایل پیوست یا لینک‌های درون پیام را بررسی فرمایید.',
  },
};

const number = (value: number) => faNumber(Math.max(0, Math.round(value)));
const money = (value: number) => faMoney(Math.max(0, Math.round(value)));

const duration = (ms: number) => {
  if (!ms || ms < 1) return '—';
  if (ms < 1000) return `${number(ms)} میلی‌ثانیه`;
  return `${(ms / 1000).toLocaleString('fa-IR', {
    maximumFractionDigits: 1,
  })} ثانیه`;
};

const errorInfo = (code: string) =>
  ERROR_FA[code] ?? {
    label: code || 'خطای پردازش',
    action: 'گزارش جزئیات رویداد را بررسی کرده یا در صورت تکرار با پشتیبانی مطرح نمایید.',
  };

/**
 * Modern SVG Circular Progress Gauge
 */
function RingGauge({
  value,
  size = 56,
  strokeWidth = 5.5,
  tone = 'brand',
  label = 'موفقیت',
}: {
  value: number;
  size?: number;
  strokeWidth?: number;
  tone?: 'brand' | 'success' | 'danger';
  label?: string;
}) {
  const percent = Math.min(100, Math.max(0, Math.round(value)));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;

  const colorVar =
    tone === 'success'
      ? 'var(--success)'
      : tone === 'danger'
      ? 'var(--danger)'
      : 'var(--brand)';

  return (
    <div className="analytics-ring-gauge" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="analytics-ring-gauge__bg"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
        />
        <circle
          className="analytics-ring-gauge__fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          stroke={colorVar}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="analytics-ring-gauge__label">
        <strong>{number(percent)}٪</strong>
        {label ? <span>{label}</span> : null}
      </div>
    </div>
  );
}

interface DailyPoint {
  day: string;
  total: number;
  breakdown: Array<{ name: string; count: number }>;
}

function shiftIsoDay(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/**
 * Modern, Interactive RTL Daily Activity Chart
 */
function DailyActivityChart({ points }: { points: DailyPoint[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null);
  const activeBarRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const max = Math.max(1, ...points.map((p) => p.total));
  const active = activeIndex !== null ? points[activeIndex] : points[points.length - 1];

  // Quick summary stats
  const totalMonth = useMemo(() => points.reduce((acc, p) => acc + p.total, 0), [points]);
  const activeDays = useMemo(() => points.filter((p) => p.total > 0).length, [points]);
  const avgDaily = useMemo(
    () => (points.length ? Math.round(totalMonth / points.length) : 0),
    [totalMonth, points.length],
  );
  const peakPoint = useMemo(() => {
    return points.reduce((highest, p) => (p.total > highest.total ? p : highest), points[0] ?? { day: '', total: 0, breakdown: [] });
  }, [points]);

  useLayoutEffect(() => {
    if (activeIndex === null || !activeBarRef.current || !tooltipRef.current) {
      setTooltipPos(null);
      return;
    }

    const updateTooltip = () => {
      const barRect = activeBarRef.current?.getBoundingClientRect();
      const tooltip = tooltipRef.current;
      if (!barRect || !tooltip) return;

      const gap = 12;
      const margin = 14;
      const width = tooltip.offsetWidth;
      const height = tooltip.offsetHeight;
      let left = barRect.left + barRect.width / 2 - width / 2;
      left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
      let top = barRect.top - height - gap;
      if (top < margin) {
        top = Math.min(window.innerHeight - height - margin, barRect.bottom + gap);
      }
      top = Math.max(margin, top);
      setTooltipPos({ left, top });
    };

    updateTooltip();
    window.addEventListener('resize', updateTooltip, { passive: true });
    window.addEventListener('scroll', updateTooltip, { passive: true, capture: true });
    return () => {
      window.removeEventListener('resize', updateTooltip);
      window.removeEventListener('scroll', updateTooltip, true);
    };
  }, [activeIndex, active?.day, active?.total]);

  if (!points.length) {
    return <div className="analytics-chart__empty">دادهٔ روند فعالیت روزانه برای این بازه یافت نشد.</div>;
  }

  return (
    <div className="analytics-chart-container" dir="rtl">
      {/* Top 4 Stat Tiles */}
      <div className="analytics-chart__metrics">
        <div className="analytics-chart__metric-box">
          <span>کل عملیات ۳۰ روزه</span>
          <strong>{number(totalMonth)}</strong>
          <small>رویداد ثبت‌شده</small>
        </div>
        <div className="analytics-chart__metric-box">
          <span>میانگین فعالیت روزانه</span>
          <strong>{number(avgDaily)}</strong>
          <small>عملیات در روز</small>
        </div>
        <div className="analytics-chart__metric-box">
          <span>اوج ترافیک</span>
          <strong>{number(peakPoint.total)}</strong>
          <small>{peakPoint.day ? faDateShort(`${peakPoint.day}T12:00:00`) : '—'}</small>
        </div>
        <div className="analytics-chart__metric-box">
          <span>روزهای با فعالیت</span>
          <strong>{number(activeDays)} <span style={{ fontSize: 13, fontWeight: 700 }}>از {number(points.length)} روز</span></strong>
          <small>ضریب حضور فعال</small>
        </div>
      </div>

      {/* Visual Bar Plot Zone */}
      <div className="analytics-chart__plot-area" role="img" aria-label="نمودار میله‌ای روند فعالیت ۳۰ روز اخیر">
        <div className="analytics-chart__gridline analytics-chart__gridline--top" />
        <div className="analytics-chart__gridline analytics-chart__gridline--mid" />
        <div className="analytics-chart__gridline analytics-chart__gridline--bottom" />

        <div className="analytics-chart__bars">
          {points.map((point, index) => {
            const ratio = point.total / max;
            const isActive = index === activeIndex || (activeIndex === null && index === points.length - 1);
            const heightPercent = point.total ? Math.max(8, Math.round(ratio * 100)) : 0;

            return (
              <button
                ref={activeIndex === index ? activeBarRef : undefined}
                key={point.day}
                type="button"
                className={`analytics-chart__bar ${isActive ? 'is-active' : ''} ${point.total === 0 ? 'is-zero' : ''}`}
                aria-label={`${faDateShort(`${point.day}T12:00:00`)}، ${number(point.total)} اقدام`}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseLeave={() => setActiveIndex(null)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
              >
                <span className="analytics-chart__bar-val">{point.total > 0 ? number(point.total) : ''}</span>
                <span
                  className="analytics-chart__bar-fill"
                  style={{ height: `${heightPercent}%` }}
                />
                <span className="analytics-chart__bar-label">
                  {faDateShort(`${point.day}T12:00:00`).slice(5)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Embedded Live Day Inspector */}
      <div className="analytics-chart__inspector" aria-live="polite">
        <div className="analytics-chart__inspector-head">
          <div className="analytics-chart__inspector-date">
            <span className="analytics-chart__inspector-pulse" />
            <div>
              <span>جزئیات روز منتخب:</span>
              <strong>{active ? faDateShort(`${active.day}T12:00:00`) : '—'}</strong>
            </div>
          </div>
          <div className="analytics-chart__inspector-sum">
            <span>مجموع اقدامات روز:</span>
            <b>{active ? number(active.total) : '۰'}</b>
          </div>
        </div>

        <div className="analytics-chart__inspector-tags">
          {active?.breakdown.length ? (
            active.breakdown.map((item) => (
              <span key={item.name} className="analytics-chart__inspector-chip">
                <em>{eventLabel(item.name)}</em>
                <b>{number(item.count)}</b>
              </span>
            ))
          ) : (
            <span className="analytics-chart__inspector-empty">
              در این روز هیچ عملیاتی ثبت نشده است.
            </span>
          )}
        </div>
      </div>

      {/* Floating Popover on Hover/Focus */}
      {activeIndex !== null && active ? (
        <div
          ref={tooltipRef}
          role="tooltip"
          className={`analytics-chart__popover ${tooltipPos ? 'is-visible' : ''}`}
          style={tooltipPos ? { left: tooltipPos.left, top: tooltipPos.top } : { left: 14, top: 14 }}
        >
          <div className="analytics-chart__popover-head">
            <span>{faDateShort(`${active.day}T12:00:00`)}</span>
            <b>{number(active.total)} اقدام</b>
          </div>
          <div className="analytics-chart__popover-list">
            {active.breakdown.length ? (
              active.breakdown.map((item) => (
                <div key={item.name} className="analytics-chart__popover-row">
                  <span>{eventLabel(item.name)}</span>
                  <b>{number(item.count)}</b>
                </div>
              ))
            ) : (
              <div className="analytics-chart__popover-empty">بدون رویداد ثبت‌شده</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Analytics() {
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [events, setEvents] = useState<EventsDto['events']>([]);
  const [postDetails, setPostDetails] = useState<Record<string, PostDetails>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let alive = true;
    if (reloadToken === 0) setLoading(true);
    else setRefreshing(true);

    setLoadError(null);
    setEventsError(null);

    void (async () => {
      try {
        const [summaryResult, eventsResult] = await Promise.allSettled([
          api.get<unknown>('/api/v1/analytics/summary?days=30'),
          getRecentActivity(),
        ]);
        if (!alive) return;

        if (summaryResult.status === 'rejected') {
          setLoadError(analyticsErrorMessage(summaryResult.reason));
          return;
        }
        if (!isSummaryDto(summaryResult.value)) {
          setLoadError(
            'ساختار پاسخ آمار با قرارداد مورد انتظار سازگار نیست. دوباره تلاش کنید؛ در صورت تکرار، پشتیبانی را مطلع کنید.',
          );
          return;
        }

        const s = summaryResult.value;
        setSummary(s);

        if (eventsResult.status === 'fulfilled' && isEventsDto(eventsResult.value)) {
          setEvents(eventsResult.value.events);
        } else {
          setEvents([]);
          setEventsError(
            eventsResult.status === 'rejected'
              ? analyticsErrorMessage(eventsResult.reason)
              : 'ساختار پاسخ فهرست فعالیت‌ها معتبر نیست.',
          );
        }

        const ids = s.topPosts.slice(0, 5).map((post) => post.id);
        const details = await Promise.allSettled(
          ids.map(async (id) => [id, await api.get<PostDetails>(`/api/v1/posts/${id}`)] as const),
        );
        if (!alive) return;

        const map: Record<string, PostDetails> = {};
        for (const result of details) {
          if (result.status === 'fulfilled') map[result.value[0]] = result.value[1];
        }
        setPostDetails(map);
      } catch (error) {
        if (alive) setLoadError(analyticsErrorMessage(error));
      } finally {
        if (alive) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [reloadToken]);

  const retryAnalytics = () => setReloadToken((current) => current + 1);

  const daily = useMemo(() => {
    const map = new Map<string, { total: number; breakdown: Map<string, number> }>();

    for (const row of summary?.daily ?? []) {
      const day = String(row.day).slice(0, 10);
      const current = map.get(day) ?? { total: 0, breakdown: new Map<string, number>() };
      const count = Number(row.count ?? 0);
      current.total += count;
      current.breakdown.set(row.eventName, (current.breakdown.get(row.eventName) ?? 0) + count);
      map.set(day, current);
    }

    const endDay = String(summary?.to ?? new Date().toISOString()).slice(0, 10);
    const totalDays = Math.max(1, Math.min(90, Number(summary?.days ?? 30)));
    return Array.from({ length: totalDays }, (_, index) => {
      const day = shiftIsoDay(endDay, index - (totalDays - 1));
      const value = map.get(day) ?? { total: 0, breakdown: new Map<string, number>() };
      return {
        day,
        total: value.total,
        breakdown: Array.from(value.breakdown.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => ({ name, count })),
      };
    });
  }, [summary]);

  const errorRows = useMemo(() => {
    const map = new Map<string, number>();

    for (const row of summary?.automation.errors ?? []) {
      const key = `${row.eventType}::${row.errorCode}`;
      map.set(key, (map.get(key) ?? 0) + Number(row.count ?? 0));
    }

    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([key, count]) => {
        const [eventType, errorCode] = key.split('::');
        return { eventType, errorCode, count };
      });
  }, [summary]);

  if (loading) return <PageLoading />;

  if (loadError || !summary) {
    return (
      <div className="analytics-page">
        <Card className="analytics-card analytics-error-state">
          <div className="analytics-error-state__icon">⚠️</div>
          <div className="analytics-error-state__body">
            <strong>دریافت اطلاعات تحلیلی با مشکل مواجه شد</strong>
            <p>{loadError ?? 'اطلاعات آمار در دسترس نیست.'}</p>
            <div style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-primary" onClick={retryAnalytics}>
                تلاش دوباره
              </button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const platforms = (['telegram', 'bale', 'rubika', 'wordpress'] as PlatformKey[]).map(
    (platform) => {
      const item = summary.platforms?.[platform] ?? { sent: 0, failed: 0 };
      return {
        platform,
        sent: Number(item.sent ?? 0),
        failed: Number(item.failed ?? 0),
      };
    },
  );

  const totalPlatformOps = platforms.reduce((acc, p) => acc + p.sent + p.failed, 0);

  const aiRate = Number(summary.automation.ai.successRate ?? 0);
  const workflowRate = Number(summary.automation.workflows.successRate ?? 0);
  const totalRevenue = Number(summary.revenue.paymentsCompletedRial ?? 0);
  const totalEvents = Number(summary.events.total ?? (summary.events.sent + summary.events.failed));
  const successRate =
    summary.successRate !== null
      ? summary.successRate
      : totalEvents > 0
      ? Math.round((summary.events.sent / totalEvents) * 100)
      : 100;

  return (
    <div className="analytics-page" dir="rtl">
      {/* ========================================================
          1. Hero Header with Live Pulse and Action Bar
          ======================================================== */}
      <header className="analytics-hero">
        <div className="analytics-hero__info">
          <span className="analytics-eyebrow">
            <span className="analytics-hero__pulse" />
            مرکز تحلیل و آمار عملکرد
          </span>
          <h1>داشبورد جامع آمار و بازخورد</h1>
          <p>
            پایش یکپارچه‌ی وضعیت ارسال محتوا، شبکه‌های پیام‌رسان متصل، هوش مصنوعی، گردش‌کارها و شاخص‌های مالی در ۳۰ روز اخیر.
          </p>
        </div>

        <div className="analytics-hero__actions">
          <div className="analytics-hero__range">
            <div className="analytics-hero__dot" />
            <div>
              <strong>۳۰ روز اخیر</strong>
              <span>
                {faDateShort(summary.from)} تا {faDateShort(summary.to)}
              </span>
            </div>
          </div>

          <button
            type="button"
            className={`btn btn-secondary analytics-hero__refresh-btn ${refreshing ? 'is-refreshing' : ''}`}
            onClick={retryAnalytics}
            disabled={refreshing}
            title="به‌روزرسانی لحظه‌ای آمار"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={refreshing ? 'spin-anim' : ''}
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
              <path d="M16 21h5v-5" />
            </svg>
            <span>{refreshing ? 'در حال دریافت...' : 'تازه‌سازی داده‌ها'}</span>
          </button>
        </div>
      </header>

      {/* ========================================================
          2. Master 4 KPI Stat Cards
          ======================================================== */}
      <section className="analytics-kpi-grid">
        {/* KPI 1: Sent Successfully */}
        <Card className="analytics-kpi analytics-kpi--success">
          <div className="analytics-kpi__top">
            <div className="analytics-kpi__glyph">🚀</div>
            <Badge tone="success">
              {totalEvents > 0 ? `${number(Math.round((summary.events.sent / totalEvents) * 100))}٪ سهم` : '۱۰۰٪'}
            </Badge>
          </div>
          <div className="analytics-kpi__value">{number(summary.events.sent)}</div>
          <div className="analytics-kpi__label">ارسال‌های موفق</div>
          <div className="analytics-kpi__meta">محتواهای با تحویل قطعی در کانال‌ها و وب‌سایت</div>
        </Card>

        {/* KPI 2: Failed Deliveries */}
        <Card className="analytics-kpi analytics-kpi--danger">
          <div className="analytics-kpi__top">
            <div className="analytics-kpi__glyph">⚠️</div>
            <Badge tone={summary.events.failed > 0 ? 'danger' : 'muted'}>
              {summary.events.failed > 0 ? `${number(summary.events.failed)} مورد` : 'بدون خطا'}
            </Badge>
          </div>
          <div className="analytics-kpi__value">{number(summary.events.failed)}</div>
          <div className="analytics-kpi__label">خطاهای تحویل و ارسال</div>
          <div className="analytics-kpi__meta">نیازمند بررسی توکن یا دسترسی مدیر ربات</div>
        </Card>

        {/* KPI 3: Overall Success Rate */}
        <Card className="analytics-kpi analytics-kpi--ring">
          <div className="analytics-kpi__top">
            <RingGauge
              value={successRate}
              tone={successRate >= 90 ? 'success' : successRate >= 70 ? 'brand' : 'danger'}
            />
            <Badge tone={successRate >= 90 ? 'success' : successRate >= 70 ? 'brand' : 'danger'}>
              {successRate >= 90 ? 'پایداری عالی' : successRate >= 70 ? 'پایداری مطلوب' : 'نیازمند بررسی'}
            </Badge>
          </div>
          <div className="analytics-kpi__value">{number(successRate)}٪</div>
          <div className="analytics-kpi__label">نرخ کلی موفقیت</div>
          <div className="analytics-kpi__meta">نسبت کل ارسال‌های موفق به کل اقدامات</div>
        </Card>

        {/* KPI 4: Link Clicks */}
        <Card className="analytics-kpi analytics-kpi--brand">
          <div className="analytics-kpi__top">
            <div className="analytics-kpi__glyph">🔗</div>
            <Badge tone="brand">لینک‌های هوشمند</Badge>
          </div>
          <div className="analytics-kpi__value">{number(summary.links.clicks)}</div>
          <div className="analytics-kpi__label">تعامل و کلیک پیوندها</div>
          <div className="analytics-kpi__meta">کلیک‌های کاربران روی لینک‌های اختصاصی رهگیری</div>
        </Card>
      </section>

      {/* ========================================================
          3. Platform Breakdown (Telegram, Bale, Rubika, WordPress)
          ======================================================== */}
      <Card className="analytics-card">
        <div className="analytics-card__head">
          <div>
            <h2>عملکرد به تفکیک پلتفرم‌های پیام‌رسان و وب‌سایت</h2>
            <p className="analytics-card__meta">
              بررسی مقایسه‌ای حجم ارسال، نرخ موفقیت و خطاهای گزارش‌شده در هر بستر متصل.
            </p>
          </div>
          <Badge tone="muted">۴ بستر فعال</Badge>
        </div>

        <div className="analytics-platform-grid">
          {platforms.map((item) => {
            const total = item.sent + item.failed;
            const rate = total > 0 ? Math.round((item.sent / total) * 100) : 100;
            const shareOfAll = totalPlatformOps > 0 ? Math.round((total / totalPlatformOps) * 100) : 0;

            return (
              <div key={item.platform} className={`analytics-platform-card analytics-platform-card--${item.platform}`}>
                <div className="analytics-platform-card__top">
                  <div className="analytics-platform-card__name">
                    <PlatformIcon platform={item.platform} size={26} />
                    <strong>{PLATFORM_FA[item.platform] ?? item.platform}</strong>
                  </div>
                  <Badge tone={rate >= 90 ? 'success' : rate >= 70 ? 'brand' : 'danger'}>
                    {number(rate)}٪ موفق
                  </Badge>
                </div>

                <div className="analytics-platform-card__total">
                  {number(total)}
                  <span>عملیات</span>
                </div>
                <div className="analytics-platform-card__caption">
                  سهم از کل ترافیک: <b>{number(shareOfAll)}٪</b>
                </div>

                {/* Dual-color Progress Bar */}
                <div className="analytics-bar">
                  <div className="analytics-bar__track">
                    <div
                      className="analytics-bar__fill analytics-bar__fill--success"
                      style={{ width: `${total > 0 ? (item.sent / total) * 100 : 0}%` }}
                    />
                    <div
                      className="analytics-bar__fill analytics-bar__fill--danger"
                      style={{ width: `${total > 0 ? (item.failed / total) * 100 : 0}%` }}
                    />
                  </div>
                </div>

                <div className="analytics-platform-card__metrics">
                  <span className="analytics-pill analytics-pill--success">
                    موفق: <b>{number(item.sent)}</b>
                  </span>
                  <span className="analytics-pill analytics-pill--danger">
                    خطا: <b>{number(item.failed)}</b>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ========================================================
          4. Interactive RTL Activity & Traffic Timeline Chart
          ======================================================== */}
      <Card className="analytics-card">
        <div className="analytics-card__head">
          <div>
            <h2>روند فعالیت و ترافیک روزانه</h2>
            <p className="analytics-card__meta">
              نمودار تعاملی ۳۰ روز اخیر؛ با حرکت نشانگر روی هر میله، آمار و تفکیک رویدادهای همان روز نمایش داده می‌شود.
            </p>
          </div>
          <Badge tone="brand">تایم‌لاین زنده</Badge>
        </div>

        <DailyActivityChart points={daily} />
      </Card>

      {/* ========================================================
          5. Two-Column Balanced Grid 1: Top Posts & Error Analysis
          ======================================================== */}
      <div className="analytics-pair-grid">
        {/* Card 1: Top High-Traffic Posts */}
        <Card className="analytics-card">
          <div className="analytics-card__head">
            <div>
              <h2>پست‌های پرتراکنش</h2>
              <p className="analytics-card__meta">پست‌هایی که بیشترین حجم انتشار و رویداد را داشته‌اند.</p>
            </div>
            <Link to="/dashboard/posts" className="analytics-card__link">
              همه پست‌ها ←
            </Link>
          </div>

          {summary.topPosts.length === 0 ? (
            <EmptyState
              icon="📊"
              title="پستی ثبت نشده است"
              description="پس از انتشار اولین پست‌ها در کانال‌ها، آمار آن‌ها در این بخش تحلیل خواهد شد."
            />
          ) : (
            <div className="analytics-list">
              {summary.topPosts.slice(0, 5).map((post, idx) => {
                const detail = postDetails[post.id];
                const groups = new Map<
                  string,
                  { channel: string; platform: string; sent: number; failed: number }
                >();

                for (const target of detail?.targets ?? []) {
                  const key = `${target.channelRef}::${target.platform}`;
                  const current = groups.get(key) ?? {
                    channel: target.channelTitle || 'کانال مقصد',
                    platform: target.platform,
                    sent: 0,
                    failed: 0,
                  };
                  if (target.state === 'SENT') current.sent += 1;
                  if (target.state === 'FAILED') current.failed += 1;
                  groups.set(key, current);
                }

                return (
                  <div key={post.id} className="analytics-list-row">
                    <span className="analytics-list-row__index">{number(idx + 1)}</span>
                    <div className="analytics-list-row__main">
                      <div className="analytics-list-row__title">
                        <Link to={`/dashboard/posts/${post.id}`}>
                          {post.title || detail?.post?.title || 'پست بدون عنوان'}
                        </Link>
                        <Badge tone="brand">{number(post.events)} رویداد</Badge>
                      </div>

                      {groups.size ? (
                        <div className="analytics-list-row__sub">
                          {Array.from(groups.values()).map((g) => (
                            <span key={`${g.channel}-${g.platform}`}>
                              <PlatformIcon platform={g.platform} size={15} />
                              <b>{g.channel}</b>
                              <span style={{ color: 'var(--success)' }}>{number(g.sent)} موفق</span>
                              {g.failed > 0 ? (
                                <span style={{ color: 'var(--danger)' }}>{number(g.failed)} خطا</span>
                              ) : null}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="analytics-list-row__muted">
                          کانال‌های مقصد در حال همگام‌سازی...
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Card 2: Error Diagnostics & Actionable Fixes */}
        <Card className="analytics-card">
          <div className="analytics-card__head">
            <div>
              <h2>رایج‌ترین خطاها و راهنمای رفع</h2>
              <p className="analytics-card__meta">تشخیص هوشمند علل ناموفق بودن و راهکار رفع سریع.</p>
            </div>
            <Badge tone={errorRows.length ? 'danger' : 'success'}>
              {errorRows.length ? `${number(errorRows.length)} نوع خطا` : 'بدون خطا'}
            </Badge>
          </div>

          {errorRows.length === 0 ? (
            <div className="analytics-success-state">
              <div className="analytics-success-state__icon">✓</div>
              <strong>پایداری کامل شبکه</strong>
              <p>هیچ خطای پرتکراری در این بازه ثبت نشده و تمامی اتصالات با موفقیت برقرارند.</p>
            </div>
          ) : (
            <div className="analytics-list">
              {errorRows.map((item) => {
                const info = errorInfo(item.errorCode);
                return (
                  <div key={`${item.eventType}-${item.errorCode}`} className="analytics-error-row">
                    <div className="analytics-error-row__head">
                      <div>
                        <strong>{info.label}</strong>
                        <span>{EVENT_FA[item.eventType] ?? 'رویداد سیستمی'}</span>
                      </div>
                      <Badge tone="danger">{number(item.count)} بار تکرار</Badge>
                    </div>
                    <div className="analytics-error-tip">
                      <span className="analytics-error-tip__icon">💡</span>
                      <p>
                        <b>اقدام پیشنهادی:</b> {info.action}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* ========================================================
          6. Two-Column Balanced Grid 2: AI/Workflows + Financial
          ======================================================== */}
      <div className="analytics-pair-grid">
        {/* Card 3: AI & Workflows */}
        <Card className="analytics-card">
          <div className="analytics-card__head">
            <div>
              <h2>هوش مصنوعی و اتوماسیون فرآیندها</h2>
              <p className="analytics-card__meta">عملکرد تولید متن، پردازش محتوا و اجرای خودکار گردش‌کارها.</p>
            </div>
            <Badge tone="brand">اتوماسیون هوشمند</Badge>
          </div>

          <div className="analytics-mini-grid">
            {/* AI Engine Subcard */}
            <div className="analytics-mini-card">
              <div className="analytics-mini-card__head">
                <div>
                  <strong>موتور هوش مصنوعی</strong>
                  <span>پردازش‌های تکمیل‌شده</span>
                </div>
                <RingGauge value={aiRate} size={48} strokeWidth={4.5} />
              </div>

              <div className="analytics-mini-card__primary-val">
                {number(summary.automation.ai.completed)}
                <small>پردازش موفق</small>
              </div>

              <div className="analytics-mini-card__stats">
                <span className="analytics-pill">
                  درخواست: <b>{number(summary.automation.ai.requested)}</b>
                </span>
                <span className="analytics-pill analytics-pill--danger">
                  خطا: <b>{number(summary.automation.ai.failed)}</b>
                </span>
                <span className="analytics-pill">
                  توکن: <b>{number(summary.automation.ai.tokens)}</b>
                </span>
                <span className="analytics-pill">
                  زمان پاسخ: <b>{duration(Number(summary.automation.ai.avgDurationMs ?? 0))}</b>
                </span>
              </div>
            </div>

            {/* Workflow Automation Subcard */}
            <div className="analytics-mini-card">
              <div className="analytics-mini-card__head">
                <div>
                  <strong>گردش‌های کار خودکار</strong>
                  <span>انتشار و پردازش بدون دخالت</span>
                </div>
                <RingGauge value={workflowRate} size={48} strokeWidth={4.5} />
              </div>

              <div className="analytics-mini-card__primary-val">
                {number(summary.automation.workflows.completed)}
                <small>اجرای موفق</small>
              </div>

              <div className="analytics-mini-card__stats">
                <span className="analytics-pill">
                  شروع‌شده: <b>{number(summary.automation.workflows.started)}</b>
                </span>
                <span className="analytics-pill analytics-pill--danger">
                  خطا: <b>{number(summary.automation.workflows.failed)}</b>
                </span>
                <span className="analytics-pill">
                  زمان اجرا: <b>{duration(Number(summary.automation.workflows.avgDurationMs ?? 0))}</b>
                </span>
              </div>
            </div>
          </div>
        </Card>

        {/* Card 4: Financial & Subscription Insights */}
        <Card className="analytics-card">
          <div className="analytics-card__head">
            <div>
              <h2>درآمد، اشتراک و کیف پول</h2>
              <p className="analytics-card__meta">گردش مالی، تمدید اشتراک‌ها و امتیازات معرفی در ۳۰ روز اخیر.</p>
            </div>
            <Link to="/dashboard/wallet" className="analytics-card__link">
              مدیریت کیف پول ←
            </Link>
          </div>

          <div className="analytics-revenue-hero">
            <div>
              <span>مجموع پرداخت‌های موفق</span>
              <strong>{money(totalRevenue)}</strong>
              <small>ریال ({money(Math.round(totalRevenue / 10))} تومان)</small>
            </div>
            <Badge tone="success">تراکنش‌های قطعی</Badge>
          </div>

          <div className="analytics-revenue-grid">
            <div className="analytics-revenue-card">
              <span>درآمد مستقیم اشتراک</span>
              <strong>{money(summary.revenue.subscriptionRevenueRial)}</strong>
              <small>ریال</small>
            </div>

            <div className="analytics-revenue-card">
              <span>شارژ کیف پول کاربران</span>
              <strong>{money(summary.revenue.walletTopupRial)}</strong>
              <small>ریال</small>
            </div>

            <div className="analytics-revenue-card">
              <span>اشتراک‌های جدید خریده‌شده</span>
              <strong>{number(summary.revenue.subscriptionsCreated)}</strong>
              <small>کاربر جدید</small>
            </div>

            <div className="analytics-revenue-card">
              <span>اشتراک‌های تمدیدشده</span>
              <strong>{number(summary.revenue.subscriptionsRenewed)}</strong>
              <small>تمدید موفق</small>
            </div>

            <div className="analytics-revenue-card">
              <span>اشتراک‌های منقضی‌شده</span>
              <strong>{number(summary.revenue.subscriptionsExpired)}</strong>
              <small>نیاز به یادآوری</small>
            </div>

            <div className="analytics-revenue-card">
              <span>امتیازات پاداش معرف</span>
              <strong>{number(summary.revenue.referralRewardPoints)}</strong>
              <small>امتیاز هدیه</small>
            </div>
          </div>
        </Card>
      </div>

      {/* ========================================================
          7. Recent Live Activity Stream
          ======================================================== */}
      <Card className="analytics-card">
        <div className="analytics-card__head">
          <div>
            <h2>آخرین رویدادهای ثبت‌شده در حساب</h2>
            <p className="analytics-card__meta">جریان زنده از فعالیت‌های اخیر ارسال، ربات‌ها، پرداخت‌ها و ورود به حساب.</p>
          </div>
          <Badge tone="muted">۲۴ رویداد اخیر</Badge>
        </div>

        {eventsError ? (
          <div className="analytics-inline-warning" role="alert">
            <span>{eventsError}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={retryAnalytics}>
              تلاش مجدد
            </button>
          </div>
        ) : events.length === 0 ? (
          <EmptyState
            icon="🧭"
            title="رویدادی ثبت نشده است"
            description="با انجام فعالیت‌ها در سامانه، گزارش لحظه‌ای آن‌ها در این جدول ثبت می‌گردد."
          />
        ) : (
          <div className="analytics-events">
            {events.map((event) => {
              const failed =
                event.name.endsWith('.failed') ||
                event.name === 'post.failed' ||
                event.name === 'payment.failed';
              const success =
                event.name.endsWith('.sent') ||
                event.name === 'post.sent' ||
                event.name === 'payment.completed' ||
                event.name === 'subscription.created';

              return (
                <div
                  key={event.id}
                  className={`analytics-event-row ${
                    failed ? 'analytics-event-row--danger' : success ? 'analytics-event-row--success' : ''
                  }`}
                >
                  <i className="analytics-event-row__dot" />
                  <div className="analytics-event-row__content">
                    <strong>{EVENT_FA[event.name] ?? 'رویداد سیستمی'}</strong>
                    <span>رویداد ثبت‌شده به شناسه {event.id.slice(0, 8)}</span>
                  </div>
                  <time>{faRelative(event.createdAt)}</time>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
