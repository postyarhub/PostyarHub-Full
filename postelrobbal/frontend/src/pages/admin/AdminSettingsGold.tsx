import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Button, Card, Field, Input, PageLoading, Select } from '../../components/ui';
import { useToast } from '../../lib/toast';
import { errText, strField } from './shared';
import { ContentComposerTextarea } from '../../components/ContentComposerTextarea';

/* ------------------------------------------------------------------ */
/* ربات طلا و سکه — server-wide defaults for the gold ticker bot       */
/* GET/PUT /admin/settings/gold →                                      */
/* { defaultSourceUrl, defaultFrequencyMinutes, defaultTemplateFa, apiToken }. */
/* ------------------------------------------------------------------ */

const FREQUENCY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 15, label: 'هر ۱۵ دقیقه' },
  { value: 30, label: 'هر ۳۰ دقیقه' },
  { value: 60, label: 'هر ۱ ساعت' },
  { value: 180, label: 'هر ۳ ساعت' },
  { value: 360, label: 'هر ۶ ساعت' },
  { value: 720, label: 'هر ۱۲ ساعت' },
  { value: 1440, label: 'هر ۲۴ ساعت' },
];

export default function AdminSettingsGold() {
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [defaultSourceUrl, setDefaultSourceUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [frequencyMinutes, setFrequencyMinutes] = useState(60);
  const [defaultTemplateFa, setDefaultTemplateFa] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const d = await api.get<Record<string, unknown>>('/api/v1/admin/settings/gold');
        if (!alive) return;
        setDefaultSourceUrl(strField(d.defaultSourceUrl));
        setApiToken(strField(d.apiToken));
        const f = Number(d.defaultFrequencyMinutes ?? 60);
        setFrequencyMinutes(Number.isFinite(f) ? f : 60);
        setDefaultTemplateFa(strField(d.defaultTemplateFa));
      } catch (err) {
        if (alive) toast.error(errText(err, 'دریافت تنظیمات ربات طلا ناموفق بود.'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (defaultSourceUrl.trim() && !defaultSourceUrl.trim().startsWith('https://')) {
      toast.error('آدرس سورس باید با https:// شروع شود.');
      return;
    }
    setSaving(true);
    try {
      await api.put('/api/v1/admin/settings/gold', {
        defaultSourceUrl: defaultSourceUrl.trim(),
        apiToken: apiToken.trim(),
        defaultFrequencyMinutes: frequencyMinutes,
        defaultTemplateFa: defaultTemplateFa.trim(),
      });
      toast.success('تنظیمات ربات طلا و سکه ذخیره شد.');
      setSavedNote(true);
    } catch (err) {
      toast.error(errText(err, 'ذخیرهٔ تنظیمات ربات طلا ناموفق بود.'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <PageLoading />;

  return (
    <>
      <div className="adm-page-head">
        <h2>ربات طلا و سکه</h2>
        <p>پیش‌فرض‌های سراسری ربات لحظه‌ای طلا و ارز برای سیستم</p>
      </div>

      {savedNote && (
        <div className="adm-note adm-note--success" role="status">
          <span aria-hidden="true">✅</span>
          <span>تنظیمات ربات طلا و سکه با موفقیت ذخیره شد.</span>
        </div>
      )}

      <div className="adm-note adm-note--info" role="note">
        <span aria-hidden="true">ℹ️</span>
        <span>
          تنظیمات زیر هم به عنوان پیش‌فرض کاربران جدید اعمال می‌شود و هم در صورتی که کاربری توکن شخصی نداشته باشد، توکن و سورس وب‌سرویس سراسری زیر مورد استفاده قرار می‌گیرد.
        </span>
      </div>

      <Card>
        <fieldset className="adm-fset">
          <legend>منبع قیمت و وب‌سرویس (API)</legend>
          <p className="adm-fset__desc">
            نشانی API و توکن احراز هویت برای استخراج لحظه‌ای نرخ طلا، سکه و ارز. می‌توانید از هر وب‌سرویسی (مانند ۲۴طلا یا سایر منابع) استفاده کنید.
          </p>

          <Field
            label="نشانی سورس / اندپوینت API"
            hint="نشانی API وب‌سرویس قیمت (مثال ۲۴طلا: https://24tala.ir/api_v2.php?r=rates)؛ خالی = اسکرپینگ منبع داخلی."
          >
            <Input
              dir="ltr"
              style={{ textAlign: 'left', fontFamily: 'monospace' }}
              value={defaultSourceUrl}
              onChange={(e) => setDefaultSourceUrl(e.target.value)}
              placeholder="https://24tala.ir/api_v2.php?r=rates"
            />
          </Field>

          <Field
            label="توکن احراز هویت وب‌سرویس (API Token / Bearer)"
            hint="توکن دریافتی از وب‌سرویس قیمت (مانند ۲۴طلا). سیستم به صورت خودکار این توکن را در قالب هدر Authorization: Bearer ارسال می‌کند."
          >
            <Input
              type="text"
              dir="ltr"
              style={{ textAlign: 'left', fontFamily: 'monospace' }}
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder="توکن وب‌سرویس (مثلاً از ۲۴طلا یا منبع دلخواه دیگر)"
            />
          </Field>
        </fieldset>

        <fieldset className="adm-fset">
          <legend>به‌روزرسانی و قالب پیام</legend>
          <p className="adm-fset__desc">فاصلهٔ پیش‌فرض گرفتن قیمت جدید و متن قالبی که برای کاربران ارسال می‌شود.</p>
          <div className="adm-form-grid">
            <Field label="فاصلهٔ به‌روزرسانی" hint="هر چند وقت یک‌بار قیمت جدید استعلام و ارسال می‌شود.">
              <Select
                value={String(frequencyMinutes)}
                onChange={(e) => setFrequencyMinutes(Number(e.target.value))}
                aria-label="فاصلهٔ به‌روزرسانی قیمت"
              >
                {FREQUENCY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="قالب پیش‌فرض پیام قیمت"
            hint="از متغیرهای {طلای ۱۸ عیار}، {سکه امامی}، {نیم سکه}، {ربع سکه}، {سکه گرمی}، {دلار}، {انس جهانی} و {یورو} می‌توانید در قالب استفاده نمایید."
          >
            <ContentComposerTextarea
              rows={9}
              value={defaultTemplateFa}
              onChange={(e) => setDefaultTemplateFa(e.target.value)}
              placeholder={'🪙 نرخ لحظه‌ای طلا، سکه و ارز:\n\nطلای ۱۸ عیار: {طلای ۱۸ عیار} تومان\nسکه امامی: {سکه امامی} تومان\nدلار: {دلار} تومان\nانس جهانی: {انس جهانی} دلار\n\nتوسط ربات پُست‌یار'}
            />
          </Field>
        </fieldset>
      </Card>

      <Card className="adm-savebar">
        <p className="adm-savebar__hint">تغییرات فوراً در پایگاه‌داده و فراخوانی‌های بعدی وب‌سرویس اعمال می‌شوند.</p>
        <Button onClick={() => void save()} loading={saving}>ذخیرهٔ تنظیمات</Button>
      </Card>
    </>
  );
}
