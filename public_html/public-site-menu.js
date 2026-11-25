(() => {
  'use strict';
  const headers = document.querySelectorAll('.top');
  headers.forEach((header) => {
    const button = header.querySelector('.nav-toggle');
    const nav = header.querySelector('#public-site-navigation');
    if (!button || !nav) return;
    const close = () => {
      header.classList.remove('is-menu-open');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', 'باز کردن منوی اصلی');
    };
    button.addEventListener('click', () => {
      const opening = !header.classList.contains('is-menu-open');
      header.classList.toggle('is-menu-open', opening);
      button.setAttribute('aria-expanded', String(opening));
      button.setAttribute('aria-label', opening ? 'بستن منوی اصلی' : 'باز کردن منوی اصلی');
    });
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!header.contains(event.target)) close();
    });
  });

  // Public static pages: show Enamad only when the current visitor has no
  // authenticated Postyar session. The SPA footer handles its own visibility.
  const footer = document.querySelector('.bottom .bottom-in');
  if (footer && !footer.querySelector('.enamad-seal')) {
    fetch('/api/v1/auth/me', {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }).then((response) => {
      if (response.ok) return;
      addEnamadSeal(footer);
    }).catch(() => addEnamadSeal(footer));
  }

  function addEnamadSeal(footer) {
    if (footer.querySelector('.enamad-seal')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'enamad-seal';
    wrapper.setAttribute('aria-label', 'نماد اعتماد الکترونیکی');
    Object.assign(wrapper.style, {
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      margin: '1.5rem auto 0',
      padding: '0.85rem 1rem',
      width: 'fit-content',
      maxWidth: '100%',
      border: '1px solid rgba(255,255,255,.16)',
      borderRadius: '1rem',
      background: 'rgba(255,255,255,.055)',
      boxSizing: 'border-box',
    });

    const link = document.createElement('a');
    link.href = 'https://trustseal.enamad.ir/?id=8262678&Code=TvRGLjcSWIuJlYKlshLimTItaATbwQ5r';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'origin';
    link.setAttribute('aria-label', 'مشاهده نماد اعتماد الکترونیکی پُست‌یار');

    const image = document.createElement('img');
    image.src = 'https://trustseal.enamad.ir/logo.aspx?id=8262678&Code=TvRGLjcSWIuJlYKlshLimTItaATbwQ5r';
    image.alt = 'نماد اعتماد الکترونیکی';
    image.referrerPolicy = 'origin';
    image.loading = 'lazy';
    image.decoding = 'async';
    Object.assign(image.style, {
      display: 'block',
      width: 'auto',
      maxWidth: '100%',
      height: 'auto',
      maxHeight: '112px',
      objectFit: 'contain',
      cursor: 'pointer',
    });

    link.appendChild(image);
    wrapper.appendChild(link);
    const meta = footer.querySelector('.bottom-meta');
    footer.insertBefore(wrapper, meta || null);
  }
})();
