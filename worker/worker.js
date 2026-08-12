/**
 * Captain X 下载校验服务（Cloudflare Worker）
 *
 * 为什么需要它：网站是纯静态的，任何写在网页里的校验都能被绕过——
 * 用户按 F12 就能看到当天的邀请码，也能看到真实下载地址。
 * 把校验放到这里之后，邀请码只存在于服务端，安装包也由这里代为转发，
 * 浏览器自始至终看不到 github.com。
 *
 * 三个接口：
 *   GET  /api/latest              最新版本号和体积（首页展示用，不含下载地址）
 *   POST /api/verify  {code}      校验邀请码，通过则发一张有时效的下载票
 *   GET  /api/download?t=<票>     校验票据后把安装包流式转发给浏览器
 *
 * 需要配置的变量（wrangler.toml 里是普通变量，密钥用 wrangler secret put）：
 *   INVITE_SALT   必填，邀请码的盐。换掉它，之前发出去的码立即全部失效。
 *   ADMIN_KEY     可选，查询当天邀请码用：GET /api/today?key=<ADMIN_KEY>
 *   ALLOW_ORIGIN  允许调用的站点，例如 https://akasolv.com
 *   GITHUB_REPO   安装包所在仓库，默认 captainzeqi/Captain-Net-Releases
 *   GITHUB_TOKEN  可选。仓库私有时必填；公开时留空即可。
 */

const DEFAULT_REPO = 'captainzeqi/Captain-Net-Releases';

// 去掉了容易看错的 0/O、1/I/L：邀请码是要用嘴念、用手抄的。
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const TICKET_TTL_SECONDS = 600;      // 下载票 10 分钟内有效，够点一次下载
const CACHE_SECONDS = 300;           // 版本信息缓存，避免频繁打 GitHub API

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      switch (url.pathname) {
        case '/api/latest':   return await handleLatest(env, cors);
        case '/api/verify':   return await handleVerify(request, env, cors);
        case '/api/download': return await handleDownload(url, env, cors);
        case '/api/today':    return await handleToday(url, env, cors);
        default:
          return json({ error: 'not_found' }, 404, cors);
      }
    } catch (err) {
      return json({ error: 'server_error', message: String(err && err.message || err) }, 500, cors);
    }
  }
};

/* ------------------------------------------------------------------ 邀请码 */

/**
 * 当天日期（Asia/Shanghai）。
 * 用固定时区而不是服务器本地时间：Worker 跑在哪个机房都可能不一样，
 * 不定死时区的话，同一时刻不同用户算出来的"今天"会不一致。
 */
function todayKey(offsetDays = 0) {
  const now = new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return now.toISOString().slice(0, 10);   // YYYY-MM-DD
}

async function codeForDate(dateKey, salt) {
  const raw = new TextEncoder().encode(`${dateKey}|${salt}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[digest[i] % ALPHABET.length];
  return code;
}

/**
 * 只做大小写和分隔符的归一化。
 *
 * 不做"O 当成 0、I 当成 1"这类纠正：字母表本身已经把 0/O、1/I/L 全排除了，
 * 把用户输入的 O 改成 0 反而会得到一个任何合法邀请码都不可能包含的字符，
 * 那是帮倒忙。歧义字符从源头就不存在，才是真正省事的做法。
 */
function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** 邀请码比对。用固定时间比较，避免逐字符比较泄露信息。 */
function sameCode(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleToday(url, env, cors) {
  if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY)
    return json({ error: 'forbidden' }, 403, cors);
  const days = Math.min(31, Math.max(1, Number(url.searchParams.get('days') || 1)));
  const list = [];
  for (let i = 0; i < days; i++) {
    const date = todayKey(i);
    list.push({ date, code: await codeForDate(date, requireSalt(env)) });
  }
  return json({ timezone: 'Asia/Shanghai', codes: list }, 200, cors);
}

function requireSalt(env) {
  if (!env.INVITE_SALT) throw new Error('INVITE_SALT 未配置');
  return env.INVITE_SALT;
}

/* ------------------------------------------------------------------ 下载票 */

async function signTicket(env, expiresAt) {
  const payload = `${expiresAt}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(requireSalt(env)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return `${expiresAt}.${base64url(mac)}`;
}

async function verifyTicket(env, ticket) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 2) return false;
  const expiresAt = Number(parts[0]);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expected = await signTicket(env, expiresAt);
  return sameCode(expected, `${expiresAt}.${parts[1]}`);
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ------------------------------------------------------------------ 接口 */

async function handleVerify(request, env, cors) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

  let body = {};
  try { body = await request.json(); } catch { /* 空请求体按空码处理 */ }

  const salt = requireSalt(env);
  const supplied = normalizeCode(body.code);
  if (!supplied) return json({ ok: false, error: 'empty' }, 400, cors);

  // 也接受昨天的码：用户可能在临近零点时拿到码、过一会儿才来下载，
  // 为这几分钟让他重新找人要一次并不合理。
  const candidates = await Promise.all([
    codeForDate(todayKey(0), salt),
    codeForDate(todayKey(-1), salt)
  ]);
  const matched = candidates.some((expected) => sameCode(normalizeCode(expected), supplied));
  if (!matched) return json({ ok: false, error: 'invalid' }, 200, cors);

  const ticket = await signTicket(env, Date.now() + TICKET_TTL_SECONDS * 1000);
  return json({ ok: true, ticket, expiresIn: TICKET_TTL_SECONDS }, 200, cors);
}

async function handleLatest(env, cors) {
  const release = await fetchLatestRelease(env);
  if (!release) return json({ error: 'unavailable' }, 502, cors);
  return json({
    version: release.tag,
    size: release.size,
    // 故意不返回下载地址：拿到版本号不等于拿到安装包。
    publishedAt: release.publishedAt
  }, 200, { ...cors, 'Cache-Control': `public, max-age=${CACHE_SECONDS}` });
}

async function handleDownload(url, env, cors) {
  if (!(await verifyTicket(env, url.searchParams.get('t'))))
    return json({ error: 'expired' }, 403, cors);

  const release = await fetchLatestRelease(env);
  if (!release) return json({ error: 'unavailable' }, 502, cors);

  // 由 Worker 代为取回并转发，浏览器只看到本站域名。
  // 用流式转发而不是先缓冲：安装包 150MB 上下，缓冲会直接超内存。
  const upstream = await fetch(release.downloadUrl, { headers: githubHeaders(env, true) });
  if (!upstream.ok || !upstream.body) return json({ error: 'upstream', status: upstream.status }, 502, cors);

  const headers = new Headers(cors);
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${release.name}"`);
  const length = upstream.headers.get('content-length');
  if (length) headers.set('Content-Length', length);
  headers.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: 200, headers });
}

/* ------------------------------------------------------------------ GitHub */

function githubHeaders(env, forDownload = false) {
  const headers = {
    'User-Agent': 'captain-x-download-gate',
    Accept: forDownload ? 'application/octet-stream' : 'application/vnd.github+json'
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchLatestRelease(env) {
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders(env),
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }
  });
  if (!response.ok) return null;
  const release = await response.json();
  const assets = release.assets || [];
  // 改名前的资产叫 CaptainNet-v*.exe，两种都认，优先新名字。
  const asset = assets.find((a) => /^CaptainX-v.*\.exe$/i.test(a.name))
             || assets.find((a) => /^CaptainNet-v.*\.exe$/i.test(a.name));
  if (!asset) return null;
  return {
    tag: release.tag_name || '',
    name: asset.name,
    size: asset.size || 0,
    publishedAt: release.published_at || '',
    // 私有仓库要走 API 地址才能带 token 下载；公开仓库两种都行。
    downloadUrl: env.GITHUB_TOKEN
      ? `https://api.github.com/repos/${repo}/releases/assets/${asset.id}`
      : asset.browser_download_url
  };
}

/* ------------------------------------------------------------------ 工具 */

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}
