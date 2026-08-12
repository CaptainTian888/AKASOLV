(() => {
  'use strict';

  // 校验服务地址。部署 worker/ 目录后把这里换成 wrangler 输出的地址。
  // 留空时下载按钮会明确告知"下载通道尚未开启"，而不是悄悄失败。
  const API_BASE = '';

  const downloadButtons = () => document.querySelectorAll('[data-download]');

  /* ---------------------------------------------------------------- 版本信息 */

  // 只取版本号和体积，不取下载地址：下载地址必须凭邀请码换取。
  if (API_BASE) {
    fetch(`${API_BASE}/api/latest`)
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((info) => {
        const size = info.size ? ` · ${(info.size / 1048576).toFixed(0)} MB` : '';
        const label = `${info.version || ''}${size}`.trim();
        if (label) downloadButtons().forEach((button) => { button.title = label; });
      })
      .catch(() => { /* 拿不到版本信息不影响下载流程，静默即可 */ });
  }

  /* ---------------------------------------------------------------- 邀请码 */

  const inviteMask = document.querySelector('.invite-mask');
  const inviteForm = document.querySelector('.invite-form');
  const inviteInput = document.querySelector('.invite-input');
  const inviteSubmit = document.querySelector('.invite-submit');
  const inviteStatus = document.querySelector('.invite-status');
  const toast = document.querySelector('.download-toast');
  let toastTimer;

  const setStatus = (text, kind) => {
    if (!inviteStatus) return;
    inviteStatus.textContent = text || '';
    inviteStatus.className = `invite-status${kind ? ' ' + kind : ''}`;
  };

  const openInvite = () => {
    if (!inviteMask) return;
    inviteMask.hidden = false;
    document.body.classList.add('invite-open');
    setStatus('');
    if (inviteInput) { inviteInput.value = ''; inviteInput.focus(); }
  };

  const closeInvite = () => {
    if (!inviteMask) return;
    inviteMask.hidden = true;
    document.body.classList.remove('invite-open');
  };

  downloadButtons().forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      openInvite();
    });
  });

  document.querySelector('.invite-close')?.addEventListener('click', closeInvite);
  inviteMask?.addEventListener('click', (event) => { if (event.target === inviteMask) closeInvite(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && inviteMask && !inviteMask.hidden) closeInvite();
  });

  inviteForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = (inviteInput?.value || '').trim();
    if (!code) { setStatus('请先填写邀请码。', 'bad'); return; }
    if (!API_BASE) { setStatus('下载通道尚未开启，请稍后再来，或联系作者获取安装包。', 'bad'); return; }

    if (inviteSubmit) { inviteSubmit.disabled = true; inviteSubmit.textContent = '正在验证…'; }
    setStatus('');
    try {
      const response = await fetch(`${API_BASE}/api/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const result = await response.json().catch(() => ({}));
      if (!result.ok) {
        setStatus(result.error === 'empty' ? '请先填写邀请码。' : '邀请码不正确，或已经过期。请确认后重试。', 'bad');
        return;
      }
      setStatus('验证通过，开始下载。', 'good');
      if (toast) {
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
      }
      // 下载走本站接口，浏览器看到的始终是本站域名。
      window.location.href = `${API_BASE}/api/download?t=${encodeURIComponent(result.ticket)}`;
      setTimeout(closeInvite, 1200);
    } catch {
      setStatus('网络不通，暂时无法验证。请检查网络后重试。', 'bad');
    } finally {
      if (inviteSubmit) { inviteSubmit.disabled = false; inviteSubmit.textContent = '验证并下载'; }
    }
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

  /* ---------------------------------------------------------------- 反馈表单 */

  // 表单本身是可以直接 POST 的，没有 JS 也能提交（会跳到 FormSubmit 的页面）。
  // 这里接管一下改用它的 ajax 接口，用户留在原页，成功失败都就地提示。
  const form = document.querySelector('.feedback-form');
  if (form) {
    const status = form.querySelector('.form-status');
    const submit = form.querySelector('button[type="submit"]');
    const endpoint = form.action.replace('formsubmit.co/', 'formsubmit.co/ajax/');

    const say = (text, kind) => {
      if (!status) return;
      status.textContent = text;
      status.classList.remove('ok', 'bad');
      if (kind) status.classList.add(kind);
    };

    form.addEventListener('submit', async (event) => {
      // 蜜罐被填说明是机器人，直接当作已提交，不真的发出去
      if (form.elements._honey && form.elements._honey.value) {
        event.preventDefault();
        return;
      }
      if (!form.checkValidity()) {
        event.preventDefault();
        form.reportValidity();
        return;
      }
      event.preventDefault();

      submit.disabled = true;
      say('正在发送…');
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { Accept: 'application/json' },
          body: new FormData(form)
        });
        if (!response.ok) throw new Error(response.status);
        form.reset();
        say('已收到，感谢反馈！需要回复的话我会发到你留的邮箱。', 'ok');
      } catch {
        // ajax 走不通就退回普通提交，别把用户的内容弄丢
        say('发送失败，正在改用普通方式提交…', 'bad');
        form.submit();
        return;
      } finally {
        submit.disabled = false;
      }
    });
  }
})();
