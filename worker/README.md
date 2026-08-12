# Captain X 下载校验服务

网站是纯静态的，写在网页里的校验都能被绕过。这个 Worker 把邀请码校验和
安装包转发放到服务端：邀请码不出现在网页里，安装包也由它代为转发，
浏览器自始至终看不到 github.com。

## 部署（约五分钟）

```bash
cd worker
npx wrangler login                    # 浏览器里授权一次
npx wrangler secret put INVITE_SALT   # 随便一串长口令，越长越好
npx wrangler secret put ADMIN_PASSWORD # 后台密码，用长一点的
npx wrangler secret put ADMIN_KEY      # 可选，命令行快捷查询用
npx wrangler deploy
```

账号名在 `wrangler.toml` 里，默认 `admin`，改成别的更好。

部署完会输出一个地址，形如 `https://captainx-download.<你的账号>.workers.dev`。
把它填进网站根目录 `config.js` 的 `CAPTAINX_API_BASE`，提交推送即可——
首页和后台页共用这一处配置。

有自己的域名时，在 Cloudflare 控制台给这个 Worker 加一条路由
（例如 `api.akasolv.com/*`），把 `CAPTAINX_API_BASE` 换成该地址，
再把 `wrangler.toml` 里的 `ALLOW_ORIGIN` 改成网站域名。

### 可选：开启"手动换一组邀请码"

```bash
npx wrangler kv namespace create INVITE_KV
```

把命令输出的 id 填进 `wrangler.toml` 里被注释掉的 `[[kv_namespaces]]`，
去掉注释再 `npx wrangler deploy`。不做这一步其余功能一样能用，
只是后台的「换一组」按钮会告诉你没开这个能力。登录失败限速也依赖它。

## 后台

浏览器打开 `你的网站/admin.html`，用上面设的账号密码登录，
就能看到今天起若干天的邀请码，点一下即复制。

这一页首页上没有入口，也标了 noindex，但它终究是一个公开可访问的静态页面——
拦得住的是服务端的账号密码，不是"别人不知道这个网址"。密码要设得足够长。

不想开浏览器时也可以直接查：

```
https://<你的 Worker 地址>/api/today?key=<ADMIN_KEY>
https://<你的 Worker 地址>/api/today?key=<ADMIN_KEY>&days=7
```

## 邀请码是怎么来的

由「日期 + `INVITE_SALT` + 轮换次数」算出，每天 0 点（东八区）自动换一组，
不需要人工维护。对拿不到盐的人来说，它和随机抽的码没有区别。

为什么是算出来而不是抽一串随机数存起来：那样每天第一个访客到达的瞬间会有并发写，
两个请求可能各自生成一组码，先发出去的那组随后被覆盖，用户手里的码就失效了。
算出来的码没有这个问题——任何时候、任何机房、并发多少次，结果都一样。

需要作废重发时，在后台点「换一组」。它只把轮换次数 +1 存进 KV，
下一次算出来的就是全新的一组，旧的立刻失效。

没有轮换过的日子还可以离线算，不依赖服务：

```bash
node tools/invite-code.mjs <INVITE_SALT>          # 今天
node tools/invite-code.mjs <INVITE_SALT> 7        # 未来七天
```

换掉 `INVITE_SALT`，此前发出去的码立刻全部作废（后台登录票、下载票也一并失效）。

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/latest` | 最新版本号与体积，供首页展示。**不返回下载地址** |
| `POST /api/verify` | 提交 `{"code":"..."}`，通过则发一张十分钟有效的下载票 |
| `GET /api/download?t=<票>` | 校验票据后把安装包流式转发给浏览器 |
| `POST /api/admin/login` | 提交 `{"user":"...","password":"..."}`，换一张八小时的登录票 |
| `GET /api/admin/codes?days=7` | 带 `Authorization: Bearer <登录票>`，查邀请码 |
| `POST /api/admin/rotate` | 同上，`{"date":"YYYY-MM-DD"}`，把那天的码换一组（需 KV） |
| `GET /api/today?key=<ADMIN_KEY>` | 不开浏览器时的快捷查询 |

## 自测

```bash
node worker/test.mjs
```

直接调用 `worker.js` 导出的 `fetch`，不用起服务。覆盖邀请码校验、下载票伪造与过期、
后台登录与锁定、换码前后新旧码的生效与失效。

## 边界

- 邀请码按天生成，同一天内所有人共用一组。需要"每人一码、可单独作废"时，
  得把每张码单独存进 KV，这个 Worker 没有做。
- 下载票没有绑定设备或 IP，十分钟内可以被转给别人用。要更严格就缩短
  `TICKET_TTL_SECONDS`，或把票和 IP 一起签名。
- 后台登录票是签名串，不能单独吊销；改 `INVITE_SALT` 会让所有票立即失效。
- 登录失败限速按 IP 计，且只在绑了 KV 时生效。换 IP 可以绕开，
  真正的防线是密码长度。
- 安装包仍然放在 GitHub 公开发布仓库里。网站上看不到那个地址，
  但知道仓库名的人依然可以直接去仓库下载——应用内自动更新也依赖它。
  要彻底封死，需要把仓库转为私有并配置 `GITHUB_TOKEN`，同时改造应用内更新。
