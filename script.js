(() => {
  'use strict';

  const RELEASE_API = 'https://api.github.com/repos/captainzeqi/Captain-Net-Releases/releases/latest';
  const RELEASE_PAGE = 'https://github.com/captainzeqi/Captain-Net-Releases/releases/latest';
  const downloadLinks = () => document.querySelectorAll('[data-download]');

  /* ---------------------------------------------------------------- 下载提示 */

  const toast = document.querySelector('.download-toast');
  let toastTimer;
  downloadLinks().forEach((link) => {
    link.addEventListener('click', () => {
      if (!toast) return;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
    });
  });

  /* ---------------------------------------------------------------- 取最新版本 */

  // 拿到最新 Release 的资产就直接指向它，取不到就退回发布页，
  // 无论如何按钮都是可点的，不会出现点了没反应。
  fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } })
    .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
    .then((release) => {
      const asset = (release.assets || []).find((item) => /^CaptainNet-v.*\.exe$/i.test(item.name));
      if (!asset) return;
      const size = asset.size ? ` · ${(asset.size / 1048576).toFixed(0)} MB` : '';
      downloadLinks().forEach((link) => {
        link.href = asset.browser_download_url;
        link.title = `${release.tag_name || ''}${size}`.trim();
      });
    })
    .catch(() => {
      downloadLinks().forEach((link) => { link.href = RELEASE_PAGE; });
    });

  /* ---------------------------------------------------------------- 窄屏导航 */

  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('main-nav');
  if (toggle && nav) {
    const setOpen = (open) => {
      nav.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '收起导航' : '展开导航');
    };
    toggle.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
    nav.addEventListener('click', (event) => { if (event.target.tagName === 'A') setOpen(false); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setOpen(false); });
    // 从窄屏拉回宽屏时要复位，否则 max-height 会残留把导航压住
    window.addEventListener('resize', () => { if (window.innerWidth > 900) setOpen(false); });
  }

  /* ---------------------------------------------------------------- 入场动画 */

  // 只有确认支持 IntersectionObserver 且用户没关动效时，才先隐藏元素再淡入。
  // 原来是无条件加 .reveal 再观察，一旦观察器不可用，整块内容就永远停在透明状态。
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if ('IntersectionObserver' in window && !reduceMotion) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('revealed');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px' });

    document.querySelectorAll('.feature-card, .step, .section-heading').forEach((item) => {
      item.classList.add('reveal');
      observer.observe(item);
    });

    // 兜底：万一有元素因为布局原因始终没触发，两秒后把已经进入视口的一次性放出来。
    setTimeout(() => {
      document.querySelectorAll('.reveal:not(.revealed)').forEach((item) => {
        if (item.getBoundingClientRect().top < window.innerHeight) item.classList.add('revealed');
      });
    }, 2000);
  }
})();
