import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError } from '../../lib/api';
import { Button, Card, EmptyState, Field, StatCard } from '../../components/ui';
import { ContentComposerTextarea } from '../../components/ContentComposerTextarea';
import { faNumber } from '../../lib/format';
import { useToast } from '../../lib/toast';

interface AiJob {
  status?: string | null;
  outputText?: string | null;
  errorCode?: string | null;
}

const ACTIONS = [
  { id: 'caption', label: '✍️ ساخت کپشن', placeholder: 'مثلاً: معرفی تخفیف ۲۰ درصدی نوروزی روی کرم مرطوب‌کنندهٔ پوست' },
  { id: 'rewrite', label: '✨ بازنویسی و بهبود لحن', placeholder: 'متنی که می‌خواهید لحن آن روان‌تر و جذاب‌تر شود را اینجا بنویسید یا الصاق کنید...' },
  { id: 'hashtags', label: '#️⃣ استخراج هشتگ‌ها', placeholder: 'موضوع یا متن پست خود را وارد کنید تا هشتگ‌های مرتبط و پربازدید پیشنهاد شوند...' },
  { id: 'summary', label: '📋 خلاصه‌سازی نکات کلیدی', placeholder: 'متن طولانی یا مقاله را وارد کنید تا نکات مهم آن خلاصه شود...' },
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

export default function Ai() {
  const toast = useToast();
  const [usageLoading, setUsageLoading] = useState(true);
  const [used, setUsed] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [limit, setLimit] = useState<number | null>(null);

  const [activeAction, setActiveAction] = useState('caption');
  const [text, setText] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<AiJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const usage = await api.get<{ requestCount?: number; tokenCount?: number }>('/api/v1/ai/usage');
        if (!alive) return;
        setUsed(Number(usage.requestCount ?? 0));
        setTokens(Number(usage.tokenCount ?? 0));
        const me = await api
          .get<{ plan?: { limits?: { ai_monthly?: number } } }>('/api/v1/subscriptions/me')
          .catch(() => null);
        if (!alive) return;
        const l = me?.plan?.limits?.ai_monthly;
        setLimit(typeof l === 'number' ? l : null);
      } catch {
        // usage card stays at zero
      } finally {
        if (alive) setUsageLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // polling loop: every 2 seconds until terminal state
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    const tick = async () => {
      try {
        const d = await api.get<{ job?: AiJob }>(`/api/v1/ai/jobs/${jobId}`);
        if (!alive) return;
        const j = d.job ?? null;
        setJob(j);
        const st = j?.status ?? '';
        if (st !== 'COMPLETED' && st !== 'FAILED') {
          timerRef.current = window.setTimeout(() => void tick(), 2000);
        }
      } catch {
        if (alive) timerRef.current = window.setTimeout(() => void tick(), 3000);
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [jobId]);

  const generate = useCallback(async () => {
    if (!text.trim()) {
      toast.error('متن یا موضوع مورد نظرتان را وارد کنید.');
      return;
    }
    setSubmitting(true);
    setJob(null);
    setJobId(null);

    let promptPayload = text.trim();
    if (activeAction === 'rewrite') {
      promptPayload = `لطفاً متن زیر را با لحنی صمیمی، گیرا، روان و بدون اشکال نگارشی بازنویسی و زیباتر کن:\n\n${text.trim()}`;
    } else if (activeAction === 'hashtags') {
      promptPayload = `برای موضوع یا متن زیر، دسته‌ای از بهترین و پربازدیدترین هشتگ‌های مرتبط و ترند فارسی و انگلیسی مناسب شبکه‌های اجتماعی بنویس:\n\n${text.trim()}`;
    } else if (activeAction === 'summary') {
      promptPayload = `لطفاً متن زیر را خلاصه کن و نکات کلیدی و مهم آن را به صورت بالت‌پوینت‌های خوانا و کاربردی بیان کن:\n\n${text.trim()}`;
    }

    try {
      const d = await api.post<{ jobId?: string }>('/api/v1/ai/caption', { text: promptPayload });
      if (!d.jobId) {
        toast.error('درخواست ساخته نشد؛ دوباره تلاش کنید.');
        return;
      }
      setJobId(d.jobId);
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : 'ارسال درخواست ناموفق بود.');
    } finally {
      setSubmitting(false);
    }
  }, [text, activeAction, toast]);

  const currentPlaceholder = ACTIONS.find((a) => a.id === activeAction)?.placeholder || '';
  const status = job?.status ?? null;
  const running = submitting || (jobId !== null && status === null) || status === 'QUEUED' || status === 'RUNNING';

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
            <span style={{ fontSize: 20 }}>🧠</span>
            <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 900, margin: 0, color: 'var(--text)' }}>
              دستیار هوش مصنوعی
            </h1>
          </div>
          <p style={{ color: 'var(--text-2)', fontSize: 13, margin: 0 }}>
            تولید محتوا، بازنویسی روان و آماده‌سازی پست‌های جذاب با موتور هوشمند و اختصاصی پُست‌یار.
          </p>
        </div>
      </header>

      {!usageLoading && (
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
          <StatCard
            icon="🧠"
            bg="var(--brand-soft)"
            value={limit !== null && limit > 0 ? `${faNumber(used)} از ${faNumber(limit)}` : faNumber(used)}
            label="درخواست هوش مصنوعی در این ماه"
          />
          <StatCard icon="🔤" bg="var(--info-soft)" value={faNumber(tokens)} label="نویسه‌های مصرفی این ماه" />
        </div>
      )}

      <div className="ai-workspace-grid">
        <Card pad="lg" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>
              انتخاب نوع پردازش هوش مصنوعی:
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {ACTIONS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setActiveAction(a.id)}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 11,
                    fontSize: 13,
                    fontWeight: activeAction === a.id ? 800 : 600,
                    border: activeAction === a.id ? '1.5px solid var(--brand)' : '1px solid var(--border)',
                    background: activeAction === a.id ? 'var(--brand-soft)' : 'var(--surface)',
                    color: activeAction === a.id ? 'var(--brand-strong)' : 'var(--text)',
                    boxShadow: activeAction === a.id ? '0 2px 8px rgba(99, 102, 241, 0.15)' : 'none',
                    cursor: 'pointer',
                    transition: 'all 0.16s ease',
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>

          <Field label="متن یا موضوع مورد نظر" required hint="توضیح اولیه، موضوع یا متنی که می‌خواهید پردازش شود را وارد کنید.">
            <ContentComposerTextarea
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={currentPlaceholder}
            />
          </Field>

          <Button onClick={() => void generate()} loading={submitting} block size="lg">
            {activeAction === 'caption' ? '✍️ ساخت خودکار کپشن' : activeAction === 'rewrite' ? '✨ بازنویسی متن' : activeAction === 'hashtags' ? '#️⃣ استخراج هشتگ‌ها' : '📋 خلاصه‌سازی نکات کلیدی'}
          </Button>
        </Card>

        <Card pad="lg" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h2 style={{ fontSize: 15, fontWeight: 800, margin: 0 }}>نتیجهٔ تولیدشده</h2>
            {status === 'COMPLETED' && (
              <span className="badge badge-success" style={{ fontSize: 11 }}>تولید موفق</span>
            )}
            {running && (
              <span className="badge badge-warning" style={{ fontSize: 11 }}>در حال پردازش</span>
            )}
          </div>

          {running && (
            <div style={{ flex: 1, minHeight: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--text-2)', fontSize: 13.5 }}>
              <span className="spinner spinner-lg" aria-hidden="true" />
              <span>هوش مصنوعی در حال پردازش و نگارش محتوای شماست…</span>
            </div>
          )}

          {!running && status === 'FAILED' && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <EmptyState
                icon="⛔"
                title="تولید پاسخ ناموفق بود"
                description={
                  job?.errorCode === 'AI_QUOTA_EXCEEDED'
                    ? 'سهمیهٔ هوش مصنوعی پلن شما تمام شده است؛ ماه آینده دوباره در دسترس خواهد بود یا پلن را ارتقا دهید.'
                    : 'سرویس هوش مصنوعی موقتاً در دسترس نیست. چند لحظه بعد دوباره تلاش کنید.'
                }
              />
            </div>
          )}

          {!running && status === 'COMPLETED' && (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div
                style={{
                  flex: 1,
                  whiteSpace: 'pre-wrap',
                  fontSize: 14,
                  lineHeight: 2.1,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 14,
                  padding: '16px 18px',
                  marginBottom: 16,
                  minHeight: 180,
                  overflowY: 'auto',
                  maxHeight: 460,
                }}
              >
                {job?.outputText || '—'}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <Button
                  variant="primary"
                  onClick={() => {
                    void copyText(job?.outputText ?? '').then((ok) => {
                      if (ok) toast.success('متن با موفقیت کپی شد.');
                      else toast.error('کپی انجام نشد؛ متن را دستی انتخاب کنید.');
                    });
                  }}
                >
                  📋 کپی متن نتیجه
                </Button>
              </div>
            </div>
          )}

          {!running && !status && (
            <div style={{ flex: 1, minHeight: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px 10px', textAlign: 'center' }}>
              <span style={{ fontSize: 36, marginBottom: 8, opacity: 0.6 }}>💡</span>
              <p style={{ color: 'var(--text-2)', fontSize: 13.5, margin: 0, maxWidth: 320, lineHeight: 1.8 }}>
                موضوع یا متن خود را در کادر مقابل وارد کنید و دکمه را بزنید؛ نتیجه به صورت هوشمند اینجا نمایش داده خواهد شد.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
