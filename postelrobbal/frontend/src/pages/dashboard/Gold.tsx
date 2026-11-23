import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiRequestError, type ChannelDto } from '../../lib/api';
import { Button, Card, EmptyState, Field, Input, PageLoading, Select } from '../../components/ui';
import { ContentComposerTextarea } from '../../components/ContentComposerTextarea';
import { faRelative } from '../../lib/format';
import { useToast } from '../../lib/toast';

interface GoldConfig {
  sourceUrl?: string;
  apiToken?: string | null;
  templateText?: string;
  channelIds?: string[];
  frequencyMinutes?: number;
  changeOnly?: boolean;
  isEnabled?: boolean;
  lastRunAt?: string | null;
}

const FREQUENCIES: Array<{ value: number; label: string }> = [
  { value: 15, label: 'هر ۱۵ دقیقه' },
  { value: 30, label: 'هر ۳۰ دقیقه' },
  { value: 60, label: 'هر ۱ ساعت' },
  { value: 180, label: 'هر ۳ ساعت' },
  { value: 360, label: 'هر ۶ ساعت' },
  { value: 720, label: 'هر ۱۲ ساعت' },
  { value: 1440, label: 'هر ۲۴ ساعت' },
];

export default function Gold() {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [sourceUrl, setSourceUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [sourceMode, setSourceMode] = useState<'default' | 'custom'>('default');
  const [templateText, setTemplateText] = useState('');
  const [frequencyMinutes, setFrequencyMinutes] = useState(60);
  const [changeOnly, setChangeOnly] = useState(true);
  const [isEnabled, setIsEnabled] = useState(false);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [channels, setChannels] = useState<ChannelDto[]>([]);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [cfg, chs] = await Promise.all([
        api.get<{ config?: GoldConfig }>('/api/v1/gold/config'),
        api.get<{ channels?: ChannelDto[] }>('/api/v1/channels').catch(() => ({ channels: [] as ChannelDto[] })),
      ]);
      const c = cfg.config ?? {};
      const u = typeof c.sourceUrl === 'string' ? c.sourceUrl : '';
      const tok = typeof c.apiToken === 'string' ? c.apiToken : '';
      setSourceUrl(u);
      setApiToken(tok);
      setSourceMode(u.trim() || tok.trim() ? 'custom' : 'default');
      setTemplateText(typeof c.templateText === 'string' ? c.templateText : '');
      setFrequencyMinutes(typeof c.frequencyMinutes === 'number' ? c.frequencyMinutes : 60);
      setChangeOnly(c.changeOnly !== false);
      setIsEnabled(c.isEnabled === true);
      setChannelIds(Array.isArray(c.channelIds) ? c.channelIds : []);
      setLastRunAt(c.lastRunAt ?? null);
      setChannels((chs.channels ?? []).filter((ch) => ch.status === 'ACTIVE'));
      setForbidden(false);
    } catch (err) {
      if (err instanceof ApiRequestError && (err.status === 403 || err.code === 'FORBIDDEN')) {
        setForbidden(true);
      } else {
        setLoadError(err instanceof ApiRequestError ? err.message : 'دریافت تنظیمات نرخ لحظه‌ای ناموفق بود.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const finalSourceUrl = sourceMode === 'custom' ? sourceUrl.trim() : '';
    const finalApiToken = sourceMode === 'custom' ? (apiToken.trim() || null) : null;
    if (sourceMode === 'custom' && !finalSourceUrl) {
      toast.error('نشانی منبع وب‌سرویس اختصاصی را وارد کنید یا گزینهٔ منبع پیش‌فرض سامانه را انتخاب کنید.');
      return;
    }
    if (!templateText.trim()) {
      toast.error('متن قالب را وارد کنید.');
      return;
    }
    setSaving(true);
    try {
      await api.put('/api/v1/gold/config', {
        sourceUrl: finalSourceUrl,
        apiToken: finalApiToken,
        templateText: templateText.trim(),
        channelIds,
        frequencyMinutes,
        changeOnly,
        isEnabled,
        timezone: 'Asia/Tehran',
      });
      toast.success('تنظیمات نرخ لحظه‌ای ذخیره شد.');
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : 'ذخیرهٔ تنظیمات ناموفق بود.');
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const res = await api.post<{ result: { ok: boolean; message: string | null; published: boolean } }>('/api/v1/gold/run', {});
      const r = res.result;
      if (r.ok) {
        toast.success(r.published ? 'نرخ‌ها با موفقیت دریافت و در کانال‌ها منتشر شد.' : 'نرخ‌ها دریافت شد (بدون تغییر نسبت به آخرین ارسال).');
        void load();
      } else {
        toast.error(r.message || 'بررسی نرخ ناموفق بود.');
      }
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : 'اجرای فوری ناموفق بود.');
    } finally {
      setRunning(false);
    }
  };

  if (loading) return <PageLoading />;

  if (forbidden) {
    return (
      <div>
        <h1 style={{ fontSize: 21, fontWeight: 800, marginBottom: 16 }}>ربات نرخ لحظه‌ای طلا و سکه</h1>
        <EmptyState
          icon="🪙"
          title="ماژول طلا در پلن فعلی شما فعال نیست"
          description="این امکان در پلن‌های بالاتر ارائه می‌شود؛ با ارتقای اشتراک می‌توانید نرخ دلار، سکه و طلای ۱۸ عیار را به‌صورت خودکار در کانال‌ها منتشر کنید."
          action={<Link to="/dashboard/subscription" className="btn btn-primary" style={{ display: 'inline-flex' }}>مشاهدهٔ پلن‌ها و ارتقا</Link>}
        />
      </div>
    );
  }

  if (loadError) {
    return (
      <EmptyState
        icon="🪙"
        title="خطا در دریافت تنظیمات"
        description={loadError}
        action={<Button onClick={() => void load()}>تلاش مجدد</Button>}
      />
    );
  }

  const toggleChannel = (id: string) => {
    setChannelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const insertToken = (token: string) => {
    setTemplateText((prev) => (prev ? `${prev} {${token}}` : `{${token}}`));
  };

  const AVAILABLE_TOKENS = [
    'طلای ۱۸ عیار',
    'سکه امامی',
    'دلار',
    'نیم سکه',
    'ربع سکه',
    'سکه گرمی',
    'انس جهانی',
  ];

  return (
    <div style={{ width: '100%', maxWidth: 1400, marginInline: 'auto', display: 'grid', gap: 20 }}>
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
            <span style={{ fontSize: 20 }}>🪙</span>
            <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 900, margin: 0, color: 'var(--text)' }}>
              ربات نرخ لحظه‌ای طلا و سکه
            </h1>
          </div>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: 0 }}>
            دریافت خودکار و منظم نرخ دلار، طلا و سکه از وب‌سرویس معتبر و انتشار خودکار در کانال‌های متصل.
            {lastRunAt ? ` · آخرین اجرا: ${faRelative(lastRunAt)}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Button variant="soft" onClick={() => void runNow()} loading={running}>
            ⚡ اجرای فوری و انتشار
          </Button>
          <Button onClick={() => void save()} loading={saving}>
            💾 ذخیرهٔ تنظیمات
          </Button>
        </div>
      </header>

      <div className="gold-workspace-grid">
        {/* Right main column: Sources and Template Message */}
        <div style={{ display: 'grid', gap: 18 }}>
          <Card pad="lg">
            <h2 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 12px' }}>منبع استخراج قیمت‌ها</h2>
            <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '14px 16px',
                  borderRadius: 14,
                  border: sourceMode === 'default' ? '2px solid var(--brand)' : '1px solid var(--border)',
                  background: sourceMode === 'default' ? 'var(--brand-soft)' : 'var(--surface-2)',
                  cursor: 'pointer',
                  transition: 'all 0.16s ease',
                }}
              >
                <input
                  type="radio"
                  name="sourceMode"
                  checked={sourceMode === 'default'}
                  onChange={() => setSourceMode('default')}
                  style={{ marginTop: 3, accentColor: 'var(--brand)', width: 18, height: 18 }}
                />
                <div>
                  <strong style={{ fontSize: 13.5, display: 'block', color: 'var(--text)' }}>
                    استفاده از وب‌سرویس و نرخ‌های مرکزی سامانه (توصیه‌شده - ۲۴طلا)
                  </strong>
                  <span style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginTop: 4, lineHeight: 1.7 }}>
                    در این حالت نیازی به ثبت نشانی اختصاصی یا توکن ندارید؛ پُست‌یار به‌طور خودکار از وب‌سرویس ۲۴طلا با کلید اختصاصی سامانه استفاده می‌کند.
                  </span>
                </div>
              </label>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '14px 16px',
                  borderRadius: 14,
                  border: sourceMode === 'custom' ? '2px solid var(--brand)' : '1px solid var(--border)',
                  background: sourceMode === 'custom' ? 'var(--brand-soft)' : 'var(--surface-2)',
                  cursor: 'pointer',
                  transition: 'all 0.16s ease',
                }}
              >
                <input
                  type="radio"
                  name="sourceMode"
                  checked={sourceMode === 'custom'}
                  onChange={() => setSourceMode('custom')}
                  style={{ marginTop: 3, accentColor: 'var(--brand)', width: 18, height: 18 }}
                />
                <div>
                  <strong style={{ fontSize: 13.5, display: 'block', color: 'var(--text)' }}>
                    تعریف وب‌سرویس و توکن اختصاصی من
                  </strong>
                  <span style={{ fontSize: 12, color: 'var(--text-2)', display: 'block', marginTop: 4, lineHeight: 1.7 }}>
                    اگر توکن اختصاصی از ۲۴طلا یا هر وب‌سرویس نرخ دیگری دارید، می‌توانید نشانی API و توکن خود را در کادرهای زیر وارد کنید.
                  </span>
                </div>
              </label>
            </div>

            {sourceMode === 'custom' && (
              <div
                style={{
                  padding: '16px 18px',
                  borderRadius: 14,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  display: 'grid',
                  gap: 14,
                  marginTop: 10,
                }}
              >
                <Field
                  label="نشانی وب‌سرویس اختصاصی"
                  required
                  hint="آدرس وب‌سرویس قیمت؛ مثلاً: https://24tala.ir/api_v2.php?r=rates"
                >
                  <Input
                    dir="ltr"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                    placeholder="https://24tala.ir/api_v2.php?r=rates"
                  />
                </Field>

                <Field
                  label="توکن احراز هویت وب‌سرویس (اختیاری)"
                  hint="توکن ارسالی به صورت Bearer. در صورت خالی بودن از توکن پیش‌فرض سامانه استفاده می‌شود."
                >
                  <Input
                    type="text"
                    dir="ltr"
                    style={{ textAlign: 'left', fontFamily: 'monospace' }}
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    placeholder="توکن اختصاصی شما"
                  />
                </Field>
              </div>
            )}
          </Card>

          <Card pad="lg">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h2 style={{ fontSize: 15, fontWeight: 800, margin: 0 }}>متن قالب پیام (واحد ارقام: تومان)</h2>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--text-2)', margin: '0 0 10px', lineHeight: 1.7 }}>
              روی هر یک از نشانگرهای زیر کلیک کنید تا به متن قالب اضافه شود؛ مبالغ در زمان ارسال به تومان محاسبه و درج می‌شوند:
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              {AVAILABLE_TOKENS.map((tok) => (
                <button
                  key={tok}
                  type="button"
                  className="gold-token-pill"
                  onClick={() => insertToken(tok)}
                  title={`افزودن {${tok}} به قالب`}
                >
                  ➕ {tok}
                </button>
              ))}
            </div>

            <ContentComposerTextarea
              rows={6}
              value={templateText}
              onChange={(e) => setTemplateText(e.target.value)}
              placeholder={'📊 نرخ امروز طلا، سکه و ارز:\nطلای ۱۸ عیار: {طلای ۱۸ عیار} تومان\nسکه امامی: {سکه امامی} تومان\nدلار: {دلار} تومان\nانس جهانی: {انس جهانی}'}
            />
          </Card>
        </div>

        {/* Left column: Scheduling, Channels and Controls */}
        <div style={{ display: 'grid', gap: 18 }}>
          <Card pad="lg">
            <h2 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 14px' }}>تنظیمات انتشار و زمان‌بندی</h2>

            <div style={{ display: 'grid', gap: 14 }}>
              <Field label="تناوب بررسی و ارسال خودکار" required>
                <Select value={String(frequencyMinutes)} onChange={(e) => setFrequencyMinutes(Number(e.target.value))}>
                  {FREQUENCIES.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </Select>
              </Field>

              <div style={{ display: 'grid', gap: 12, padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 12, border: '1px solid var(--border)' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={(e) => setIsEnabled(e.target.checked)}
                    style={{ width: 18, height: 18, accentColor: 'var(--brand)' }}
                  />
                  <span>فعال‌سازی ارسال خودکار ربات</span>
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, color: 'var(--text-2)' }}>
                  <input
                    type="checkbox"
                    checked={changeOnly}
                    onChange={(e) => setChangeOnly(e.target.checked)}
                    style={{ width: 18, height: 18, accentColor: 'var(--brand)' }}
                  />
                  <span>ارسال پیام فقط در صورت تغییر قیمت نسبت به آخرین انتشار</span>
                </label>
              </div>
            </div>
          </Card>

          <Card pad="lg">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ fontSize: 15, fontWeight: 800, margin: 0 }}>کانال‌های مقصد انتشار</h2>
              <span className="badge" style={{ fontSize: 11 }}>{channelIds.length} انتخاب شده</span>
            </div>

            {channels.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-2)', background: 'var(--surface-2)', borderRadius: 12, padding: '14px', textAlign: 'center', lineHeight: 1.8 }}>
                کانال فعالی متصل نشده است. <Link to="/dashboard/channels" style={{ fontWeight: 700 }}>اتصال کانال جدید</Link>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 9 }}>
                {channels.map((ch) => {
                  const isChecked = channelIds.includes(ch.id);
                  return (
                    <label
                      key={ch.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 12px',
                        borderRadius: 11,
                        border: isChecked ? '1.5px solid var(--brand)' : '1px solid var(--border)',
                        background: isChecked ? 'var(--brand-soft)' : 'var(--surface)',
                        cursor: 'pointer',
                        transition: 'all 0.14s ease',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleChannel(ch.id)}
                        style={{ width: 17, height: 17, accentColor: 'var(--brand)' }}
                      />
                      <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ch.title || ch.channelRef}
                        </strong>
                        <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
                          ({ch.platform === 'telegram' ? 'تلگرام' : ch.platform === 'bale' ? 'بله' : 'روبیکا'})
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            <div style={{ marginTop: 18 }}>
              <Button onClick={() => void save()} loading={saving} block size="lg">
                ذخیرهٔ تمام تنظیمات ربات
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
