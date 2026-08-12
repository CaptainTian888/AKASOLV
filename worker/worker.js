/**
 * Captain X 下载校验服务（Cloudflare Worker）
 *
 * 为什么需要它：网站是纯静态的，任何写在网页里的校验都能被绕过——
 * 用户按 F12 就能看到当天的邀请码，也能看到真实下载地址。
 * 把校验放到这里之后，邀请码只存在于服务端，安装包也由这里代为转发，
 * 浏览器自始至终看不到 github.com。
 *
 * 对外接口：
 *   GET  /api/latest              最新版本号和体积（首页展示用，不含下载地址）
 *   GET  /api/quota               今日下载额度，首页展示用
 *   POST /api/verify  {code}      校验邀请码，通过则发一张有时效的下载票
 *   GET  /api/download?t=<票>     校验票据后把安装包流式转发给浏览器
 *
 * 后台接口（/admin 用，需登录）：
 *   POST /api/admin/login  {user,password}   换一张 8 小时有效的登录票
 *   GET  /api/admin/codes?days=7             查今天起若干天的邀请码
 *   POST /api/admin/rotate {date}            当天的码换一组（需要 KV，见下）
 *   POST /api/admin/quota  {limit,resetToday} 改每日下载上限 / 把今天的计数清零
 *   GET  /api/today?key=<ADMIN_KEY>          不开浏览器时的快捷查询
 *
 * 需要配置的变量（wrangler.toml 里是普通变量，密钥用 wrangler secret put）：
 *   INVITE_SALT     必填，邀请码的盐。换掉它，之前发出去的码立即全部失效。
 *   ADMIN_USER      后台账号，默认 admin
 *   ADMIN_PASSWORD  后台密码，必填才能登录后台
 *   ADMIN_KEY       可选，/api/today 的快捷查询口令
 *   ALLOW_ORIGIN    允许调用的站点，例如 https://akasolv.com
 *   GITHUB_REPO     安装包所在仓库，默认 captainzeqi/Captain-Net-Releases
 *   GITHUB_TOKEN    可选。仓库私有时必填；公开时留空即可。
 *
 * 可选的 KV 绑定 INVITE_KV：手动换一组邀请码、每日下载上限、登录失败限速都要靠它。
 * 不绑定时校验和下载完全正常，只是这三样会明确告诉你没开这个能力。
 */

const DEFAULT_REPO = 'captainzeqi/Captain-Net-Releases';

// 去掉了容易看错的 0/O、1/I/L：邀请码是要用嘴念、用手抄的。
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;
const TICKET_TTL_SECONDS = 600;         // 下载票 10 分钟内有效，够点一次下载
const SESSION_TTL_SECONDS = 8 * 3600;   // 后台登录票 8 小时
const CACHE_SECONDS = 300;              // 版本信息缓存，避免频繁打 GitHub API
const LOGIN_MAX_FAILURES = 10;          // 同一 IP 连续失败上限
const LOGIN_LOCK_SECONDS = 900;         // 触顶后锁多久

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      switch (url.pathname) {
        case '/api/latest':        return await handleLatest(env, cors);
        case '/api/quota':         return await handleQuota(env, cors);
        case '/api/verify':        return await handleVerify(request, env, cors);
        case '/api/download':      return await handleDownload(url, env, cors);
        case '/api/today':         return await handleToday(url, env, cors);
        case '/api/admin/login':   return await handleAdminLogin(request, env, cors);
        case '/api/admin/codes':   return await handleAdminCodes(request, url, env, cors);
        case '/api/admin/rotate':  return await handleAdminRotate(request, env, cors);
        case '/api/admin/quota':   return await handleAdminQuota(request, env, cors);
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

/**
 * 邀请码由日期、盐、以及"第几次轮换"三者算出。
 *
 * 为什么不是抽一串随机数存起来：那样第一个访客到达的瞬间会有并发写，
 * 两个请求可能各自生成一组码，先发出去的那组随后被覆盖，用户手里的码就失效了。
 * 算出来的码没有这个问题——任何时候、任何机房、并发多少次，结果都一样，
 * 不写任何存储也能对上。对拿不到盐的人来说，它和随机抽的码没有区别。
 *
 * rotation 是"今天这组码作废重来"用的计数器，只有它需要落存储，
 * 且只在你按下"换一组"时才写一次，没有并发问题。
 */
async function codeForDate(dateKey, salt, rotation = 0) {
  // rotation 为 0 时保持和最初的算法一字不差，离线小工具算出来的仍然对得上。
  const seed = rotation > 0 ? `${dateKey}|${salt}|r${rotation}` : `${dateKey}|${salt}`;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)));
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[digest[i] % ALPHABET.length];
  return code;
}

/** 读某天的轮换次数。没绑 KV 就恒为 0，也就是从不轮换。 */
async function rotationOf(env, dateKey) {
  if (!env.INVITE_KV) return 0;
  const raw = await env.INVITE_KV.get(`rot:${dateKey}`);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function codeOf(env, dateKey) {
  return codeForDate(dateKey, requireSalt(env), await rotationOf(env, dateKey));
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

/** 固定时间比较，避免逐字符比较泄露信息。 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireSalt(env) {
  if (!env.INVITE_SALT) throw new Error('INVITE_SALT 未配置');
  return env.INVITE_SALT;
}

async function codeList(env, days) {
  const list = [];
  for (let i = 0; i < days; i++) {
    const date = todayKey(i);
    list.push({ date, code: await codeOf(env, date), rotation: await rotationOf(env, date) });
  }
  return list;
}

async function handleToday(url, env, cors) {
  if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY)
    return json({ error: 'forbidden' }, 403, cors);
  const days = clampDays(url.searchParams.get('days'));
  return json({ timezone: 'Asia/Shanghai', codes: await codeList(env, days) }, 200, cors);
}

function clampDays(raw) {
  return Math.min(31, Math.max(1, Number(raw || 1) || 1));
}

/* ------------------------------------------------------------------ 每日额度 */

const LIMIT_KEY = 'cfg:daily-limit';

/** 每日下载上限。0 表示不限量，这也是没绑 KV 时的行为。 */
async function dailyLimit(env) {
  if (!env.INVITE_KV) return 0;
  const value = Number(await env.INVITE_KV.get(LIMIT_KEY));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

async function usedOn(env, dateKey) {
  if (!env.INVITE_KV) return 0;
  return Number(await env.INVITE_KV.get(`dl:${dateKey}`)) || 0;
}

/**
 * 计数 +1。
 *
 * KV 没有原子自增，这里是"读出来加一再写回去"。两个人在同一瞬间下载时，
 * 有可能都读到 8、都写回 9，于是少记一次。对"每天放出几十份"这个量级，
 * 偏差一两次不影响判断；真要一个数都不能差，得换成 Durable Object。
 * 宁可少记也不多记：多记会把还没送出去的名额吃掉。
 */
async function bumpUsed(env, dateKey) {
  if (!env.INVITE_KV) return;
  const next = (await usedOn(env, dateKey)) + 1;
  // 留三天足够对账，过期的日子没人再看。
  await env.INVITE_KV.put(`dl:${dateKey}`, String(next), { expirationTtl: 3 * 86400 });
}

async function quotaState(env) {
  const date = todayKey(0);
  const limit = await dailyLimit(env);
  const used = await usedOn(env, date);
  return {
    date,
    // 没绑 KV，或上限设成 0，都当作不限量
    enabled: Boolean(env.INVITE_KV) && limit > 0,
    limit,
    used,
    remaining: limit > 0 ? Math.max(0, limit - used) : null
  };
}

async function handleQuota(env, cors) {
  const state = await quotaState(env);
  // 不缓存：额度就是要实时的，缓存了前台看到的数就是旧的。
  return json(state, 200, { ...cors, 'Cache-Control': 'no-store' });
}

async function handleAdminQuota(request, env, cors) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
  if (!(await requireAdmin(request, env))) return json({ error: 'unauthorized' }, 401, cors);
  if (!env.INVITE_KV) return json({ ok: false, error: 'no_kv' }, 501, cors);

  let body = {};
  try { body = await request.json(); } catch { /* 空请求体只当作查询 */ }

  if (body.limit !== undefined) {
    const limit = Number(body.limit);
    if (!Number.isFinite(limit) || limit < 0) return json({ ok: false, error: 'bad_limit' }, 400, cors);
    await env.INVITE_KV.put(LIMIT_KEY, String(Math.floor(limit)));
  }
  if (body.resetToday) await env.INVITE_KV.put(`dl:${todayKey(0)}`, '0', { expirationTtl: 3 * 86400 });

  return json({ ok: true, ...(await quotaState(env)) }, 200, cors);
}

/* ------------------------------------------------------------------ 签名票据 */

async function hmac(env, payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(requireSalt(env)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return base64url(mac);
}

/** 下载票和登录票用同一套签名，靠前缀区分，避免一种票被当另一种用。 */
async function signToken(env, kind, expiresAt) {
  return `${expiresAt}.${await hmac(env, `${kind}|${expiresAt}`)}`;
}

async function verifyToken(env, kind, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;
  const expiresAt = Number(parts[0]);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  return timingSafeEqual(await signToken(env, kind, expiresAt), `${expiresAt}.${parts[1]}`);
}

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ------------------------------------------------------------------ 后台 */

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function loginFailures(env, ip) {
  if (!env.INVITE_KV) return 0;
  return Number(await env.INVITE_KV.get(`fail:${ip}`)) || 0;
}

async function noteLoginFailure(env, ip) {
  if (!env.INVITE_KV) return;
  const next = (await loginFailures(env, ip)) + 1;
  await env.INVITE_KV.put(`fail:${ip}`, String(next), { expirationTtl: LOGIN_LOCK_SECONDS });
}

async function handleAdminLogin(request, env, cors) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
  if (!env.ADMIN_PASSWORD) return json({ ok: false, error: 'not_configured' }, 503, cors);

  const ip = clientIp(request);
  if (await loginFailures(env, ip) >= LOGIN_MAX_FAILURES)
    return json({ ok: false, error: 'locked', retryAfter: LOGIN_LOCK_SECONDS }, 429, cors);

  let body = {};
  try { body = await request.json(); } catch { /* 空请求体按空账号处理 */ }

  const user = String(body.user || '').trim();
  const password = String(body.password || '');
  const expectedUser = env.ADMIN_USER || 'admin';

  // 账号错和密码错返回同一个结果：分开提示等于告诉对方账号猜对了。
  const ok = timingSafeEqual(user, expectedUser) && timingSafeEqual(password, env.ADMIN_PASSWORD);
  if (!ok) {
    await noteLoginFailure(env, ip);
    return json({ ok: false, error: 'bad_credentials' }, 401, cors);
  }

  if (env.INVITE_KV) await env.INVITE_KV.delete(`fail:${ip}`);
  const token = await signToken(env, 'admin', Date.now() + SESSION_TTL_SECONDS * 1000);
  return json({ ok: true, token, expiresIn: SESSION_TTL_SECONDS }, 200, cors);
}

async function requireAdmin(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return verifyToken(env, 'admin', token);
}

async function handleAdminCodes(request, url, env, cors) {
  if (!(await requireAdmin(request, env))) return json({ error: 'unauthorized' }, 401, cors);
  const days = clampDays(url.searchParams.get('days'));
  return json({
    timezone: 'Asia/Shanghai',
    hasKv: Boolean(env.INVITE_KV),
    quota: await quotaState(env),
    codes: await codeList(env, days)
  }, 200, cors);
}

async function handleAdminRotate(request, env, cors) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
  if (!(await requireAdmin(request, env))) return json({ error: 'unauthorized' }, 401, cors);
  if (!env.INVITE_KV) return json({ ok: false, error: 'no_kv' }, 501, cors);

  let body = {};
  try { body = await request.json(); } catch { /* 不带日期就当今天 */ }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : todayKey(0);

  const next = (await rotationOf(env, date)) + 1;
  // 保留到该日期之后一段时间即可：过期的码本来就不再接受，留着没意义。
  await env.INVITE_KV.put(`rot:${date}`, String(next), { expirationTtl: 45 * 86400 });
  return json({ ok: true, date, rotation: next, code: await codeForDate(date, requireSalt(env), next) }, 200, cors);
}

/* ------------------------------------------------------------------ 接口 */

async function handleVerify(request, env, cors) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

  let body = {};
  try { body = await request.json(); } catch { /* 空请求体按空码处理 */ }

  const supplied = normalizeCode(body.code);
  if (!supplied) return json({ ok: false, error: 'empty' }, 400, cors);

  // 也接受昨天的码：用户可能在临近零点时拿到码、过一会儿才来下载，
  // 为这几分钟让他重新找人要一次并不合理。
  const candidates = [await codeOf(env, todayKey(0)), await codeOf(env, todayKey(-1))];
  const matched = candidates.some((expected) => timingSafeEqual(normalizeCode(expected), supplied));
  if (!matched) return json({ ok: false, error: 'invalid' }, 200, cors);

  // 名额用完就别发票了。这里先挡一次是为了把话说清楚——
  // 让人拿着一张必然被拒的票去点下载，等于把错误推迟到最难解释的时候。
  const quota = await quotaState(env);
  if (quota.enabled && quota.remaining <= 0)
    return json({ ok: false, error: 'quota_exhausted', ...quota }, 200, cors);

  const ticket = await signToken(env, 'download', Date.now() + TICKET_TTL_SECONDS * 1000);
  return json({ ok: true, ticket, expiresIn: TICKET_TTL_SECONDS, quota }, 200, cors);
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
  if (!(await verifyToken(env, 'download', url.searchParams.get('t'))))
    return json({ error: 'expired' }, 403, cors);

  // 票有十分钟有效期，期间名额可能已经被别人用完，所以这里必须再查一次。
  const quota = await quotaState(env);
  if (quota.enabled && quota.remaining <= 0) return json({ error: 'quota_exhausted', ...quota }, 429, cors);

  const release = await fetchLatestRelease(env);
  if (!release) return json({ error: 'unavailable' }, 502, cors);

  // 由 Worker 代为取回并转发，浏览器只看到本站域名。
  // 用流式转发而不是先缓冲：安装包 150MB 上下，缓冲会直接超内存。
  const upstream = await fetch(release.downloadUrl, { headers: githubHeaders(env, true) });
  if (!upstream.ok || !upstream.body) return json({ error: 'upstream', status: upstream.status }, 502, cors);

  // 计数放在确认上游可读之后：取不到安装包却扣掉一个名额，是白扣。
  await bumpUsed(env, quota.date);

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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}
