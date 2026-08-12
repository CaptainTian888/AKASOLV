(() => {
  'use strict';

  const API_BASE = window.CAPTAINX_API_BASE || '';
  // 用 sessionStorage 而不是 localStorage：关掉标签页登录票就没了，
  // 共用电脑时不会把后台一直留在那儿。
  const STORE_KEY = 'captainx-admin-token';

  const loginView = document.querySelector('[data-view="login"]');
  const codesView = document.querySelector('[data-view="codes"]');
  const form = document.querySelector('.admin-form');
  const userInput = document.querySelector('.admin-user');
  const passInput = document.querySelector('.admin-pass');
  const loginButton = document.querySelector('.admin-login');
  const loginStatus = form?.querySelector('.admin-status');
  const codesStatus = document.querySelector('.admin-codes-status');
  const list = document.querySelector('.code-list');
  const range = document.querySelector('.admin-range');

  let token = sessionStorage.getItem(STORE_KEY) || '';
  let canRotate = false;

  const say = (node, text, kind) => {
    if (!node) return;
    node.textContent = text || '';
    node.className = `${node.classList.contains('admin-codes-status') ? 'admin-status admin-codes-status' : 'admin-status'}${kind ? ' ' + kind : ''}`;
  };

  const showCodes = (on) => {
    if (loginView) loginView.hidden = on;
    if (codesView) codesView.hidden = !on;
  };

  const signOut = (message) => {
    token = '';
    sessionStorage.removeItem(STORE_KEY);
    showCodes(false);
    if (passInput) passInput.value = '';
    say(loginStatus, message || '', message ? 'bad' : '');
  };

  const api = (path, options = {}) => fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });

  /* ------------------------------------------------------------------ 登录 */

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!API_BASE) { say(loginStatus, '还没有配置校验服务地址（config.js 里的 CAPTAINX_API_BASE）。', 'bad'); return; }

    const user = (userInput?.value || '').trim();
    const password = passInput?.value || '';
    if (!user || !password) { say(loginStatus, '账号和密码都要填。', 'bad'); return; }

    if (loginButton) { loginButton.disabled = true; loginButton.textContent = '正在登录…'; }
    say(loginStatus, '');
    try {
      const response = await fetch(`${API_BASE}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, password })
      });
      const result = await response.json().catch(() => ({}));
      if (!result.ok) {
        if (result.error === 'locked') say(loginStatus, '错误次数太多，已暂时锁定，十五分钟后再试。', 'bad');
        else if (result.error === 'not_configured') say(loginStatus, '服务端还没有设置后台密码（ADMIN_PASSWORD）。', 'bad');
        else say(loginStatus, '账号或密码不对。', 'bad');
        return;
      }
      token = result.token;
      sessionStorage.setItem(STORE_KEY, token);
      if (passInput) passInput.value = '';
      showCodes(true);
      await loadCodes();
    } catch {
      say(loginStatus, '连不上校验服务，检查网络或服务地址。', 'bad');
    } finally {
      if (loginButton) { loginButton.disabled = false; loginButton.textContent = '登录'; }
    }
  });

  document.querySelector('.admin-logout')?.addEventListener('click', () => signOut());

  /* ------------------------------------------------------------------ 邀请码 */

  // 和服务端一样固定按东八区算"今天"，否则本机时区一变就标错行。
  // toISOString 本身就转成 UTC，所以只加八小时即可，不要再掺本地时区偏移。
  const todayKey = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  const render = (codes) => {
    if (!list) return;
    list.textContent = '';
    const today = todayKey();

    codes.forEach((item) => {
      const row = document.createElement('li');
      row.className = `code-row${item.date === today ? ' is-today' : ''}`;

      const date = document.createElement('span');
      date.className = 'code-date';
      date.textContent = item.date === today ? `${item.date} · 今天` : item.date;

      const code = document.createElement('button');
      code.type = 'button';
      code.className = 'code-value';
      code.textContent = item.code;
      code.title = '点击复制';
      code.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(item.code);
          code.classList.add('copied');
          setTimeout(() => code.classList.remove('copied'), 1200);
        } catch {
          // 剪贴板不可用（http 或权限被拒）时，退回选中文本让用户自己复制
          const selection = window.getSelection();
          const target = document.createRange();
          target.selectNodeContents(code);
          selection?.removeAllRanges();
          selection?.addRange(target);
          say(codesStatus, '这个浏览器不允许自动复制，已选中，按 Ctrl+C。', 'bad');
        }
      });

      row.append(date, code);

      if (item.rotation > 0) {
        const mark = document.createElement('span');
        mark.className = 'code-mark';
        mark.textContent = `已换 ${item.rotation} 次`;
        row.append(mark);
      }

      if (canRotate) {
        const rotate = document.createElement('button');
        rotate.type = 'button';
        rotate.className = 'admin-button admin-ghost code-rotate';
        rotate.textContent = '换一组';
        rotate.addEventListener('click', async () => {
          if (!confirm(`把 ${item.date} 的邀请码换成新的一组？换掉之后，已经发出去的这组立刻失效。`)) return;
          rotate.disabled = true;
          try {
            const response = await api('/api/admin/rotate', { method: 'POST', body: JSON.stringify({ date: item.date }) });
            if (response.status === 401) { signOut('登录已过期，请重新登录。'); return; }
            const result = await response.json().catch(() => ({}));
            if (!result.ok) { say(codesStatus, '换码失败，稍后再试。', 'bad'); return; }
            say(codesStatus, `${item.date} 已换新码。`, 'good');
            await loadCodes();
          } catch {
            say(codesStatus, '连不上校验服务。', 'bad');
          } finally {
            rotate.disabled = false;
          }
        });
        row.append(rotate);
      }

      list.append(row);
    });
  };

  async function loadCodes() {
    if (!token) { showCodes(false); return; }
    say(codesStatus, '正在读取…');
    try {
      const response = await api(`/api/admin/codes?days=${encodeURIComponent(range?.value || 7)}`);
      if (response.status === 401) { signOut('登录已过期，请重新登录。'); return; }
      const result = await response.json().catch(() => ({}));
      if (!Array.isArray(result.codes)) { say(codesStatus, '读取失败，稍后再试。', 'bad'); return; }
      canRotate = Boolean(result.canRotate);
      render(result.codes);
      say(codesStatus, canRotate ? '' : '没有绑定 KV，无法手动换码——码仍然每天自动更换。');
    } catch {
      say(codesStatus, '连不上校验服务。', 'bad');
    }
  }

  document.querySelector('.admin-refresh')?.addEventListener('click', loadCodes);
  range?.addEventListener('change', loadCodes);

  // 刷新页面后如果登录票还在有效期内，直接回到列表，不必重新登录
  if (token) { showCodes(true); loadCodes(); }
})();
