import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiRequestError, type NotificationDto, type Page } from '../../lib/api';
import { Button, Card, EmptyState, PageLoading, StatCard, StatusBadge } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import { faDate, faDigits, faMoney, faNumber, faRelative } from '../../lib/format';

/** Shape returned by GET /api/v1/analytics/overview (client already unwraps `data`). */
interface OverviewDto {
  channels: { total: number; active: number };
  bots: { total: number; active: number };
  posts: { total: number; published: number };
  deliveries: { sent30d: number; failed30d: number };
  wallet: { balanceRial: number };
  ai: { periodYm: string; requestCount: number; tokenCount: number };
}

const SUB_STATE_FA: Record<string, string> = {
  ACTIVE: 'فعال',
  PENDING: 'در انتظار پرداخت',
  EXPIRED: 'منقضی شده',
  CANCELLED: 'لغو شده',
};

/** Shape returned by GET /api/v1/subscriptions/current (contract 14-contract item 6). */
interface CurrentSubDto {
  subscription: { id: string; state: string; startedAt: string | null; expiresAt: string | null } | null;
  plan: { id: string; code: string; nameFa: string; priceRial: number; periodDays: number } | null;
  usage: {
    daysRemaining: number;
    postsSent: number;
    botsActive: number;
    channelsActive: number;
    limits: { postsPerMonth: number | null; bots: number | null; channels: number | null };
  };
}

function errText(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return 'خطای غیرمنتظره رخ داد. دوباره تلاش کنید.';
}

/** Usage-bar tone: brand up to 70٪, amber over 70٪, red over 90٪. */
function usageTone(pct: number): '' | 'is-amber' | 'is-red' {
  if (pct > 90) return 'is-red';
  if (pct > 70) return 'is-amber';
  return '';
}

/** RTL-friendly days-remaining ring: SVG circle, animated stroke-dashoffset,
 *  mirrored horizontally so the stroke sweeps right-to-left (§49 RTL-first). */
function DaysRing({ days, period, hasSubscription }: { days: number; period: number; hasSubscription: boolean }) {
  const R = 50;
  const C = 2 * Math.PI * R;
  const pct = hasSubscription && period > 0 ? Math.min(1, Math.max(0, days / period)) : 0;
  const tone = pct < 0.15 ? 'var(--danger)' : pct < 0.35 ? 'var(--warning)' : 'var(--brand)';
  const [offset, setOffset] = useState(C);
  useEffect(() => {
    const t = window.setTimeout(() => setOffset(C * (1 - pct)), 80);
    return () => window.clearTimeout(t);
  }, [C, pct]);
  return (
    <div style={{ position: 'relative', width: 118, height: 118, flexShrink: 0 }} role="img" aria-label={`روز باقی‌مانده اشتراک: ${faDigits(days)}`}>
      <svg width="118" height="118" viewBox="0 0 118 118">
        <g transform="scale(-1 1) translate(-118 0) rotate(-90 59 59)">
          <circle cx="59" cy="59" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="11" />
          <circle
            className="sub-ring__value"
            cx="59"
            cy="59"
            r={R}
            fill="none"
            stroke={hasSubscription ? tone : 'var(--border)'}
            strokeWidth="11"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={offset}
          />
        </g>
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        {hasSubscription ? (
          days > 1000 ? (
            <>
              <strong style={{ fontSize: 26, fontWeight: 900, lineHeight: 1.2 }}>♾️</strong>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>مادام‌العمر</span>
            </>
          ) : (
            <>
              <strong style={{ fontSize: 26, fontWeight: 900, lineHeight: 1.2 }}>{faDigits(days)}</strong>
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>روز باقی‌مانده</span>
            </>
          )
        ) : (
          <>
            <strong style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-2)' }}>بدون</strong>
            <span style={{ fontSize: 11, color: 'var(--text-2)' }}>اشتراک فعال</span>
          </>
        )}
      </div>
    </div>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const unlimited = !limit || limit <= 0;
  const pct = unlimited ? 0 : Math.min(100, Math.max(0, (used / limit) * 100));
  return (
    <div className="usage-row">
      <div className="usage-row__head">
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ color: 'var(--text-2)', fontSize: 12 }}>
          {unlimited ? (
            <>{faNumber(used)} — نامحدود</>
          ) : (
            <strong style={{ color: 'var(--text)' }}>
              {faNumber(used)} از {faNumber(limit)} · {faDigits(Math.round(pct))}٪
            </strong>
          )}
        </span>
      </div>
      <div
        className="usage-bar"
        role="progressbar"
        aria-label={label}
        aria-valuenow={unlimited ? undefined : Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`usage-bar__fill${unlimited ? ' is-unlimited' : usageTone(pct)}`}
          style={{ width: unlimited ? '100%' : `${pct}%` }}
        />
      </div>
    </div>
  );
}

function SubscriptionGaugeCard({
  loading,
  error,
  data,
  walletBalanceRial,
  onRetry,
}: {
  loading: boolean;
  error: boolean;
  data: CurrentSubDto | null;
  walletBalanceRial: number;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <Card pad="lg">
        <div className="skeleton" style={{ width: 140, height: 18, marginBottom: 18 }} />
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="skeleton" style={{ width: 118, height: 118, borderRadius: '50%' }} />
          <div style={{ flex: 1, minWidth: 180, display: 'grid', gap: 10 }}>
            <div className="skeleton" style={{ width: '55%' }} />
            <div className="skeleton" style={{ width: '75%' }} />
            <div className="skeleton" style={{ width: '40%' }} />
          </div>
        </div>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card pad="lg">
        <h3 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 700 }}>وضعیت اشتراک</h3>
        <p style={{ fontSize: 13.5, color: 'var(--text-2)', margin: '0 0 14px' }}>
          دریافت وضعیت اشتراک ناموفق بود؛ لطفاً دوباره تلاش کنید.
        </p>
        <Button size="sm" variant="soft" onClick={onRetry}>تلاش مجدد</Button>
      </Card>
    );
  }

  const { subscription, plan, usage } = data;
  const isLifetime = plan?.code === 'lifetime_admin';
  const hasSub = subscription !== null || isLifetime;
  const period = plan?.periodDays ?? 30;

  return (
    <Card
      pad="lg"
      className="sub-gauge-card"
      style={hasSub ? { background: 'linear-gradient(180deg, #ffffff 0%, var(--brand-soft) 240%)' } : undefined}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>وضعیت اشتراک</h3>
        {isLifetime ? (
          <span className="badge badge-success">دائمی / مادام‌العمر</span>
        ) : hasSub && subscription ? (
          <StatusBadge state={subscription.state} labels={SUB_STATE_FA} />
        ) : (
          <span className="badge badge-muted">بدون اشتراک فعال</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
        <DaysRing days={isLifetime ? 9999 : usage.daysRemaining} period={period} hasSubscription={hasSub} />
        <div style={{ flex: 1, minWidth: 190, display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{plan?.nameFa ?? 'پلن رایگان'}</div>
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
            {isLifetime ? (
              <>اعتبار اشتراک: <strong style={{ color: '#059669' }}>دائمی / بدون نیاز به تمدید</strong></>
            ) : hasSub && subscription?.expiresAt ? (
              <>تاریخ پایان: <strong style={{ color: 'var(--text)' }}>{faDate(subscription.expiresAt)}</strong></>
            ) : (
              <>برای انتشار نامحدود، یکی از پلن‌ها را فعال کنید.</>
            )}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-2)' }}>
            موجودی کیف پول: <strong style={{ color: 'var(--text)' }}>{faMoney(walletBalanceRial)}</strong>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gap: 14, margin: '20px 0 4px' }}>
        <UsageBar label="پست‌های ارسال‌شده" used={usage.postsSent} limit={usage.limits.postsPerMonth} />
        <UsageBar label="ربات‌های فعال" used={usage.botsActive} limit={usage.limits.bots} />
        <UsageBar label="کانال‌های فعال" used={usage.channelsActive} limit={usage.limits.channels} />
      </div>

      <div style={{ marginTop: 16 }}>
        {isLifetime ? (
          <Link to="/dashboard/admin" className="btn btn-primary" style={{ background: 'var(--brand-grad)' }}>
            👑 ورود به پنل مدیریت
          </Link>
        ) : hasSub ? (
          <Link to="/dashboard/subscription" className="btn btn-soft btn-sm">
            مدیریت اشتراک
          </Link>
        ) : (
          <Link
            to="/dashboard/subscription"
            className="btn btn-primary"
            style={{ background: 'var(--brand-grad)', boxShadow: '0 8px 20px rgba(99, 102, 241, 0.35)' }}
          >
            🚀 ارتقای اشتراک
          </Link>
        )}
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const { me } = useAuth();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [notifs, setNotifs] = useState<NotificationDto[]>([]);
  const [loadError, setLoadError] = useState(false);

  // Subscription gauge (contract item 6) — independent loader so the card can
  // skeleton/fail/retry on its own without blocking the rest of the dashboard.
  const [subData, setSubData] = useState<CurrentSubDto | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [subError, setSubError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [ov, np] = await Promise.all([
        api.get<OverviewDto>('/api/v1/analytics/overview'),
        api.get<Page<NotificationDto>>('/api/v1/notifications?pageSize=5'),
      ]);
      setOverview(ov);
      setNotifs(np.items ?? []);
    } catch (e) {
      setLoadError(true);
      toast.error(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSubscription = useCallback(async () => {
    setSubLoading(true);
    setSubError(false);
    try {
      setSubData(await api.get<CurrentSubDto>('/api/v1/subscriptions/current'));
    } catch {
      setSubError(true);
    } finally {
      setSubLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadSubscription();
  }, [loadSubscription]);

  if (loading) return <PageLoading />;

  if (loadError || !overview) {
    return (
      <EmptyState
        icon="📡"
        title="داده‌ها بارگذاری نشد"
        description="در دریافت اطلاعات داشبورد مشکلی پیش آمد. لطفاً دوباره تلاش کنید."
        action={<Button onClick={() => void load()}>تلاش مجدد</Button>}
      />
    );
  }

  const hasChannels = overview.channels.total > 0;
  const firstName = me?.user.firstName?.trim() || 'کاربر';

  return (
    <div style={{ display: 'grid', gap: 20, width: '100%', maxWidth: 1400, marginInline: 'auto' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 14,
          padding: '18px 22px',
          borderRadius: 18,
          background: 'linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(246,248,255,0.98) 100%)',
          border: '1px solid rgba(225, 230, 245, 0.85)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 20 }}>👋</span>
            <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 900, margin: 0, color: 'var(--text)' }}>
              سلام، {firstName}
            </h1>
          </div>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: 0 }}>
            این خلاصهٔ وضعیت لحظه‌ای حساب، کانال‌ها و ارسال‌های شما در پُست‌یار است.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Link to="/dashboard/posts/new" className="btn btn-primary btn-sm" style={{ gap: 6, fontWeight: 700 }}>
            ✍️ انتشار پست جدید
          </Link>
          <Link to="/dashboard/channels" className="btn btn-soft btn-sm hide-mobile" style={{ gap: 6 }}>
            📻 کانال‌ها
          </Link>
        </div>
      </header>

      {!hasChannels && (
        <EmptyState
          icon="📻"
          title="هنوز کانالی متصل نکرده‌اید"
          description="برای انتشار پست، ابتدا اولین کانال خود را در تلگرام، بله یا روبیکا متصل کنید."
          action={
            <Link to="/dashboard/channels" className="btn btn-primary">
              اتصال اولین کانال
            </Link>
          }
        />
      )}

      <div className="dash-kpi-grid">
        <StatCard icon="📻" bg="var(--brand-soft)" value={faNumber(overview.channels.total)} label="کانال متصل" />
        <StatCard icon="🤖" bg="#ecfeff" value={faNumber(overview.bots.total)} label="ربات فعال" />
        <StatCard icon="✉️" bg="#f5f3ff" value={faNumber(overview.posts.total)} label="پست ثبت‌شده" />
        <StatCard icon="🚀" bg="#ecfdf5" value={faNumber(overview.deliveries.sent30d)} label="ارسال موفق (۳۰ روز گذشته)" />
      </div>

      <div className="dash-middle-grid">
        <SubscriptionGaugeCard
          loading={subLoading}
          error={subError}
          data={subData}
          walletBalanceRial={overview.wallet.balanceRial}
          onRetry={() => void loadSubscription()}
        />

        <Card pad="lg" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>دسترسی سریع</h3>
            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>میانبرهای اصلی</span>
          </div>
          <div style={{ display: 'grid', gap: 9, flex: 1 }}>
            <Link to="/dashboard/posts/new" className="dash-quick-tile">
              <span className="dash-quick-tile__icon">✍️</span>
              <div className="dash-quick-tile__body">
                <span className="dash-quick-tile__title">انتشار پست جدید</span>
                <span className="dash-quick-tile__desc">ارسال آنی یا زمان‌بندی به تمام کانال‌ها</span>
              </div>
            </Link>
            <Link to="/dashboard/channels" className="dash-quick-tile">
              <span className="dash-quick-tile__icon">📻</span>
              <div className="dash-quick-tile__body">
                <span className="dash-quick-tile__title">اتصال و مدیریت کانال‌ها</span>
                <span className="dash-quick-tile__desc">تلگرام، بله، روبیکا</span>
              </div>
            </Link>
            <Link to="/dashboard/ai" className="dash-quick-tile">
              <span className="dash-quick-tile__icon">🧠</span>
              <div className="dash-quick-tile__body">
                <span className="dash-quick-tile__title">دستیار هوش مصنوعی</span>
                <span className="dash-quick-tile__desc">تولید کپشن، هشتگ و بازنویسی متن</span>
              </div>
            </Link>
            <Link to="/dashboard/subscription" className="dash-quick-tile">
              <span className="dash-quick-tile__icon">💎</span>
              <div className="dash-quick-tile__body">
                <span className="dash-quick-tile__title">ارتقای اشتراک</span>
                <span className="dash-quick-tile__desc">افزایش ظرفیت ارسال و امکانات پیشرفته</span>
              </div>
            </Link>
          </div>
        </Card>
      </div>

      <Card pad="lg">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>اعلان‌های اخیر</h3>
          <Link to="/dashboard/notifications" style={{ fontSize: 12.5 }}>مشاهده همه</Link>
        </div>
        {notifs.length === 0 ? (
          <p style={{ color: 'var(--text-2)', fontSize: 13.5, margin: 0 }}>اعلانی ندارید.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 0 }}>
            {notifs.map((n) => (
              <li key={n.id} style={{ padding: '12px 6px', borderBottom: '1px solid var(--border)', transition: 'background 0.15s ease' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13.5, fontWeight: n.readAt ? 500 : 700 }}>{n.titleFa}</strong>
                  {!n.readAt && <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--brand)', display: 'inline-block' }} aria-label="خوانده‌نشده" />}
                  <span style={{ color: 'var(--text-2)', fontSize: 11.5, marginInlineStart: 'auto' }}>{faRelative(n.createdAt)}</span>
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.8 }}>{n.bodyFa}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '4px 8px', color: 'var(--text-2)', fontSize: 12 }}>
        <span>تعداد پست‌های منتشرشده: <strong>{faNumber(overview.posts.published)}</strong></span>
        <span>درخواست‌های هوش مصنوعی این ماه: <strong>{faDigits(overview.ai.requestCount)}</strong></span>
      </div>
    </div>
  );
}
