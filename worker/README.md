# Captain X 下载校验服务

网站是纯静态的，写在网页里的校验都能被绕过。这个 Worker 把邀请码校验和
安装包转发放到服务端：邀请码不出现在网页里，安装包也由它代为转发，
浏览器自始至终看不到 github.com。

## 部署（约五分钟）

```bash
cd worker
npx wrangler login                 # 浏览器里授权一次
npx wrangler secret put INVITE_SALT # 随便一串长口令，越长越好
npx wrangler secret put ADMIN_KEY   # 自己查当天邀请码用
npx wrangler deploy
```

部署完会输出一个地址，形如 `https://captainx-download.<你的账号>.workers.dev`。
把它填进网站根目录 `script.js` 顶部的 `API_BASE`，提交推送即可。

有自己的域名时，在 Cloudflare 控制台给这个 Worker 加一条路由
（例如 `api.akasolv.com/*`），把 `API_BASE` 换成该地址，
再把 `wrangler.toml` 里的 `ALLOW_ORIGIN` 改成网站域名。

## 查当天的邀请码

```
https://<你的 Worker 地址>/api/today?key=<ADMIN_KEY>
https://<你的 Worker 地址>/api/today?key=<ADMIN_KEY>&days=7   # 一次看未来七天
```

邀请码由日期和 `INVITE_SALT` 算出，每天 0 点（东八区）自动换一组，
不需要人工维护。换掉 `INVITE_SALT`，此前发出去的码立刻全部作废。

也可以离线算，不依赖服务：

```bash
node tools/invite-code.mjs <INVITE_SALT>          # 今天
node tools/invite-code.mjs <INVITE_SALT> 7        # 未来七天
```

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/latest` | 最新版本号与体积，供首页展示。**不返回下载地址** |
| `POST /api/verify` | 提交 `{"code":"..."}`，通过则发一张十分钟有效的下载票 |
| `GET /api/download?t=<票>` | 校验票据后把安装包流式转发给浏览器 |
| `GET /api/today?key=<ADMIN_KEY>` | 查当天（或未来若干天）的邀请码 |

## 边界

- 邀请码按天生成，同一天内所有人共用一组。需要"每人一码、可单独作废"时，
  得换成在 KV 里存码的方案，这个 Worker 没有做。
- 下载票没有绑定设备或 IP，十分钟内可以被转给别人用。要更严格就缩短
  `TICKET_TTL_SECONDS`，或把票和 IP 一起签名。
- 安装包仍然放在 GitHub 公开发布仓库里。网站上看不到那个地址，
  但知道仓库名的人依然可以直接去仓库下载——应用内自动更新也依赖它。
  要彻底封死，需要把仓库转为私有并配置 `GITHUB_TOKEN`，同时改造应用内更新。
