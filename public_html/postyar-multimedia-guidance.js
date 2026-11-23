(() => {
  'use strict';

  const noteId = 'postyar-multimedia-guidance-note';
  const text = 'هنگام انتخاب چند تصویر، رفتار ارسال به مقصد بستگی دارد: تلگرام و بله در حالت عادی تصاویر را به‌صورت آلبوم می‌فرستند. اگر برای مقصد دکمهٔ تعاملی تنظیم شده باشد، تصاویر جداگانه ارسال می‌شوند و دکمه روی تصویر اول قرار می‌گیرد. در روبیکا تصاویر در پیام‌های جداگانه فرستاده می‌شوند. متن طولانی ممکن است جدا از تصاویر ارسال شود.';

  function addGuidance() {
    const inputs = document.querySelectorAll('input[type="file"][multiple]');
    for (const input of inputs) {
      const label = input.closest('label');
      if (!label) continue;
      const labelText = (label.textContent || '').replace(/\s+/g, '');
      if (!labelText.includes('انتخابتصویریاویدیو') && !labelText.includes('افزودنتصویر')) continue;
      const next = label.nextElementSibling;
      if (next && next.id === noteId) continue;

      const note = document.createElement('div');
      note.id = noteId;
      note.setAttribute('role', 'note');
      note.setAttribute('aria-label', 'نکتهٔ ارسال چندتصویری');
      note.dir = 'rtl';
      note.textContent = text;
      note.style.cssText = [
        'box-sizing:border-box',
        'width:100%',
        'margin-top:8px',
        'padding:8px 10px',
        'border:1px solid var(--border, #d8dee8)',
        'border-radius:10px',
        'background:var(--surface, transparent)',
        'color:var(--text-2, #5b6472)',
        'font-size:12px',
        'line-height:1.9',
        'text-align:right',
        'overflow-wrap:anywhere'
      ].join(';');
      label.insertAdjacentElement('afterend', note);
    }
  }

  function start() {
    addGuidance();
    if (document.documentElement && !window.__postyarMultimediaGuidanceObserver) {
      const observer = new MutationObserver(() => addGuidance());
      observer.observe(document.documentElement, { childList: true, subtree: true });
      window.__postyarMultimediaGuidanceObserver = observer;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
