/**
 * Worker 自测。直接调用 worker.js 导出的 fetch，不需要起服务，也不联网。
 *   node worker/test.mjs
 * GitHub 和 KV 都用假的顶上，所以跑多少遍都不会真的去拉安装包。
 */
import worker from './worker.js';
import { createHash } from 'node:crypto';

const SALT = 'local-test-salt';
const env = {
  INVITE_SALT: SALT,
  ADMIN_USER: 'boss',
  ADMIN_PASSWORD: 'correct horse battery staple',
  ADMIN_KEY: 'local-admin',
  ALLOW_ORIGIN: '*'
};

/**
 * 把 GitHub 换成假的。
 * 不这么做的话跑一次测试就会真的去拉一个 150MB 的安装包，慢、费流量，
 * 而且断网时测试会以一个和逻辑无关的理由失败。
 */
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.github.com/repos/') && url.endsWith('/releases/latest')) {
    return new Response(JSON.stringify({
      tag_name: 'v1.0.67',
      published_at: '2026-08-01T00:00:00Z',
      assets: [{ name: 'CaptainX-v1.0.67.exe', size: 152043520, id: 1, browser_download_url: 'https://asset.invalid/CaptainX.exe' }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.startsWith('https://asset.invalid/'))
    return new Response('FAKE-EXE', { status: 200, headers: { 'content-length': '8' } });
  return realFetch(input, init);
};

/** 内存版 KV，够覆盖 rot:/fail:/dl:/cfg: 几种用法。 */
function memoryKv() {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); }
  };
}

let passed = 0, failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       期望 ${JSON.stringify(expected)}\n       实际 ${JSON.stringify(actual)}`); }
};

const call = (path, options = {}, e = env) =>
  worker.fetch(new Request(`https://example.com${path}`, options), e);

const post = (path, body, options = {}, e = env) =>
  call(path, { method: 'POST', body: JSON.stringify(body), ...options }, e);

/** 独立算一遍邀请码，不复用 worker 内部函数——否则算错了两边一起错，测不出来。 */
const dateKey = (offset) =>
  new Date(Date.now() + 8 * 3600 * 1000 + offset * 86400 * 1000).toISOString().slice(0, 10);

const expectCode = (offset, rotation = 0) => {
  const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const date = dateKey(offset);
  const seed = rotation > 0 ? `${date}|${SALT}|r${rotation}` : `${date}|${SALT}`;
  const digest = createHash('sha256').update(seed).digest();
  let code = '';
  for (let i = 0; i < 8; i++) code += ALPHABET[digest[i] % ALPHABET.length];
  return code;
};

const today = expectCode(0);

console.log('\n邀请码校验');
{
  check('正确的码通过', (await (await post('/api/verify', { code: today })).json()).ok, true);
  check('小写也通过', (await (await post('/api/verify', { code: today.toLowerCase() })).json()).ok, true);
  check('带空格连字符也通过',
    (await (await post('/api/verify', { code: `${today.slice(0, 4)} - ${today.slice(4)}` })).json()).ok, true);
  check('错误的码被拒', (await (await post('/api/verify', { code: 'ZZZZZZZZ' })).json()).ok, false);
  check('空码被拒', (await (await post('/api/verify', { code: '' })).json()).error, 'empty');
  check('昨天的码仍可用', (await (await post('/api/verify', { code: expectCode(-1) })).json()).ok, true);
  check('前天的码被拒', (await (await post('/api/verify', { code: expectCode(-2) })).json()).ok, false);
  check('GET 不允许', (await call('/api/verify')).status, 405);
  check('没配盐时报错而不是放行',
    (await post('/api/verify', { code: today }, {}, { ...env, INVITE_SALT: '' })).status, 500);
}

console.log('\n下载票');
{
  const ticket = (await (await post('/api/verify', { code: today })).json()).ticket;
  const ok = await call(`/api/download?t=${encodeURIComponent(ticket)}`);
  check('票据可以换到安装包', ok.status, 200);
  check('作为附件下发', ok.headers.get('Content-Disposition'), 'attachment; filename="CaptainX-v1.0.67.exe"');
  check('内容确实转发出来了', await ok.text(), 'FAKE-EXE');
  check('没有票被拒', (await call('/api/download')).status, 403);
  check('伪造的票被拒', (await call('/api/download?t=999999999999999.abcdef')).status, 403);
  check('过期的票被拒', (await call(`/api/download?t=${Date.now() - 1000}.abcdef`)).status, 403);

  const [exp, sig] = ticket.split('.');
  const tampered = `${exp}.${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`;
  check('改一个字符的票被拒', (await call(`/api/download?t=${encodeURIComponent(tampered)}`)).status, 403);

  // 登录票不能拿来当下载票用（两种票签名时带了不同前缀）
  const login = await (await post('/api/admin/login', { user: 'boss', password: env.ADMIN_PASSWORD })).json();
  check('登录票不能当下载票', (await call(`/api/download?t=${encodeURIComponent(login.token)}`)).status, 403);
}

console.log('\n后台登录');
{
  check('账号密码正确则发票',
    (await (await post('/api/admin/login', { user: 'boss', password: env.ADMIN_PASSWORD })).json()).ok, true);
  check('密码错被拒', (await post('/api/admin/login', { user: 'boss', password: 'nope' })).status, 401);
  check('账号错被拒', (await post('/api/admin/login', { user: 'admin', password: env.ADMIN_PASSWORD })).status, 401);
  check('空请求体被拒', (await post('/api/admin/login', {})).status, 401);
  check('没配密码时不可登录',
    (await post('/api/admin/login', { user: 'boss', password: '' }, {}, { ...env, ADMIN_PASSWORD: '' })).status, 503);

  // 连续失败到上限后锁住，连正确密码也不放行
  const locked = { ...env, INVITE_KV: memoryKv() };
  for (let i = 0; i < 10; i++) await post('/api/admin/login', { user: 'boss', password: 'nope' }, {}, locked);
  check('连续失败后锁定',
    (await post('/api/admin/login', { user: 'boss', password: env.ADMIN_PASSWORD }, {}, locked)).status, 429);
}

console.log('\n后台查码');
{
  const token = (await (await post('/api/admin/login', { user: 'boss', password: env.ADMIN_PASSWORD })).json()).token;
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  check('没有票不能查码', (await call('/api/admin/codes')).status, 401);
  check('乱写的票不能查码',
    (await call('/api/admin/codes', { headers: { Authorization: 'Bearer 1.2' } })).status, 401);

  const listed = await (await call('/api/admin/codes?days=7', auth)).json();
  check('返回七天', listed.codes.length, 7);
  check('第一条是今天的码', listed.codes[0], { date: dateKey(0), code: today, rotation: 0 });
  check('没绑 KV 时不能换码', listed.hasKv, false);
  check('days 超上限被夹住', (await (await call('/api/admin/codes?days=999', auth)).json()).codes.length, 31);
  check('/api/today 口令错被拒', (await call('/api/today?key=wrong')).status, 403);
  check('/api/today 口令对可查',
    (await (await call('/api/today?key=local-admin')).json()).codes[0].code, today);
}

console.log('\n换一组邀请码');
{
  const kvEnv = { ...env, INVITE_KV: memoryKv() };
  const token = (await (await post('/api/admin/login', { user: 'boss', password: env.ADMIN_PASSWORD }, {}, kvEnv)).json()).token;
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  check('绑了 KV 就能换码', (await (await call('/api/admin/codes', auth, kvEnv)).json()).hasKv, true);
  check('没有票不能换码', (await post('/api/admin/rotate', {}, {}, kvEnv)).status, 401);

  const rotated = await (await post('/api/admin/rotate', {}, auth, kvEnv)).json();
  check('换出的码和原来不同', rotated.code !== today, true);
  check('换出的码可独立算出', rotated.code, expectCode(0, 1));
  check('查码返回新的码',
    (await (await call('/api/admin/codes', auth, kvEnv)).json()).codes[0].code, expectCode(0, 1));
  check('新码可以用来下载', (await (await post('/api/verify', { code: rotated.code }, {}, kvEnv)).json()).ok, true);
  check('旧码立刻作废', (await (await post('/api/verify', { code: today }, {}, kvEnv)).json()).ok, false);

  const again = await (await post('/api/admin/rotate', {}, auth, kvEnv)).json();
  check('再换一次计数递增', again.rotation, 2);
  check('可以指定日期换',
    (await (await post('/api/admin/rotate', { date: dateKey(3) }, auth, kvEnv)).json()).code, expectCode(3, 1));
}

console.log('\n每日下载额度');
{
  const kvEnv = { ...env, INVITE_KV: memoryKv() };
  const token = (await (await post('/api/admin/login', { user: 'boss', password: env.ADMIN_PASSWORD }, {}, kvEnv)).json()).token;
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const quota = async (e = kvEnv) => (await call('/api/quota', {}, e)).json();

  check('默认不限量', (await quota()).enabled, false);
  check('没绑 KV 时也是不限量', (await quota(env)).enabled, false);
  check('没有票不能改上限', (await post('/api/admin/quota', { limit: 5 }, {}, kvEnv)).status, 401);
  check('没绑 KV 时改不了上限', (await post('/api/admin/quota', { limit: 5 }, auth, env)).status, 501);
  check('负数被拒', (await post('/api/admin/quota', { limit: -1 }, auth, kvEnv)).status, 400);
  check('非数字被拒', (await post('/api/admin/quota', { limit: 'abc' }, auth, kvEnv)).status, 400);

  const saved = await (await post('/api/admin/quota', { limit: 2 }, auth, kvEnv)).json();
  check('上限保存后即时生效', [saved.limit, saved.remaining, saved.enabled], [2, 2, true]);
  check('前台能看到同一个数', (await quota()).remaining, 2);

  // 走两遍完整流程：验码 → 拿票 → 下载。下载真正开始时计数才 +1。
  const download = async () => {
    const ticket = (await (await post('/api/verify', { code: today }, {}, kvEnv)).json()).ticket;
    if (!ticket) return null;
    return call(`/api/download?t=${encodeURIComponent(ticket)}`, {}, kvEnv);
  };

  await download();
  check('下载一次后计数 +1', (await quota()).used, 1);
  await download();
  check('第二次之后名额归零', (await quota()).remaining, 0);

  const refused = await (await post('/api/verify', { code: today }, {}, kvEnv)).json();
  check('名额用完时正确的码也不发票', [refused.ok, refused.error], [false, 'quota_exhausted']);

  // 名额发完之前签出的票，也不能再兑现
  check('用完后旧票也被挡', (await download()) === null, true);

  const bumped = await (await post('/api/admin/quota', { limit: 5 }, auth, kvEnv)).json();
  check('调高上限后立刻放开', [bumped.used, bumped.remaining], [2, 3]);
  check('调高后又能发票', (await (await post('/api/verify', { code: today }, {}, kvEnv)).json()).ok, true);

  const cleared = await (await post('/api/admin/quota', { resetToday: true }, auth, kvEnv)).json();
  check('清零今日计数', [cleared.used, cleared.remaining], [0, 5]);

  const unlimited = await (await post('/api/admin/quota', { limit: 0 }, auth, kvEnv)).json();
  check('改回 0 就是不限量', [unlimited.enabled, unlimited.remaining], [false, null]);
  check('不限量时不再拦截', (await (await post('/api/verify', { code: today }, {}, kvEnv)).json()).ok, true);
}

console.log('\n版本信息');
{
  const latest = await (await call('/api/latest')).json();
  check('返回版本号和体积', [latest.version, latest.size], ['v1.0.67', 152043520]);
  // 这个接口不需要邀请码就能调，所以它绝不能带出下载地址
  check('不含任何下载地址', JSON.stringify(latest).includes('http'), false);
}

console.log('\n其它');
{
  check('未知路径 404', (await call('/nope')).status, 404);
  check('OPTIONS 放行', (await call('/api/verify', { method: 'OPTIONS' })).status, 204);
  check('跨域头存在',
    (await call('/api/verify', { method: 'OPTIONS' })).headers.get('Access-Control-Allow-Origin'), '*');
}


console.log(`\n通过 ${passed}，失败 ${failed}\n`);
process.exit(failed ? 1 : 0);
