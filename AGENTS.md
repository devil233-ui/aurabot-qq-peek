逐级读取上一级提示词至最高层为止。

# aurabot-mod-qq-peek

Aurabot 的用户模块「跨群看一眼」。上游插件是 `dsh-aurabot-qq`，模块契约见其 `src/modules/API.md`；本模块只依赖 `api.rule` / `api.tool` / `api.defineTool` / `api.onebot` / `api.sendText` / `api.sendSegments` / `api.log`。

改动本模块前先知道的几条：

- **不写死群号、群名、QQ 号**：白名单来自 aurabot 顶层配置 `allow.groups`，群名来自网关 `get_group_list`。仓库是公开的，历史版本里写死的真实群号必须留在历史之外（目前无）。
- **图链接不许缓存 url 本身**：图段自带的 `url` 带 rkey，一小时过期。只缓存「取到的 rkey + 过期时间」，并按 `appid` 区分群聊（1407）与私聊（1406）。
- **rkey 的三种回法都要兼容**：`nc_get_rkey`（数组、`type=20/10`）、`get_rkey`（数组）、`get_rkey_server`（`<kind>_rkey` + `expired_time`）。只认一种会在换网关实现时静默拿空值。
- **目录名 = 模块 id**：部署目录必须是 `modules/qq-peek/`，入口 `index.mjs`；仓库就检在这个目录里（跟 `aurabot-mod-memory` 一样），别再另建副本，否则线上跑的和你改的不是同一份。改名会让 `api.use('qq-peek')` 拿到 null 并被 `?.` 静默跳过。
- **改 `index.mjs` 约 10 秒热重载**，不重启宿主；改 `config.json`（白名单）才需要重启。
- **发言必须显式声明留痕标记**：hub 的 `sendText` / `sendSegments` 只有收到 `{ proactive: true, proactiveCause }` 才会在目标群 `chatlog` 补一条 `who: bot`；模块快捷 API 默认不传这个标记。段发送一律走 `api.sendSegments(chatId, segs, note, opts)`，不要用 `api.onebot('send_group_msg')` 直发——那样整条留痕被绕过（0.3.0 的丢档就是这么来的，2026-11-22 修）。
- **消息 id 是跨工具的主键**：`qq_peek_group` 每行开头的 `[id]`、`qq_msg_info` 的入参、`qq_say_in_group` 的 `quote` 都是它。改输出格式别动这个前缀。
- **模块设置声明写在模块导出里，不在 `module.json`**：面板「模块」页按 `export default { defaults, settings: [...] }` 渲染表单，值存进 `config.ext['qq-peek']`。`module.json` 里的 settings 不驱动面板（实测只改 module.json 时 `/aurabot/api/state` 仍报 `settings: []`、`version` 还是导出里那个）。settings 会随 `index.mjs` 热重载一起刷新。
- **改 `config.json` 里的 ext 值要重启宿主才进内存**：面板保存走 `setConfig` 即时生效；直接改文件只落到磁盘，得等重启（2026-11-22 就是这样把 `sayInBackground` 打开的）。
- **后台/定时回合原来拿不到本模块的工具**：这类会话是 `chat.kind === 'system'`，宿主把 `level` 落成 `social`（`src/chat/hub.js` 里 `chat.kind === 'system'` 那一支），工具选择器必须显式放行。`sayInBackground` 开关只放行 `qq_say_in_group`，`qq_peek_group` 在 system 会话里仍被挡（读历史会白吃上下文，要用再单独放）。
- **`/aurabot/api` 管理接口会校验 Host**：服务监听 `10.8.0.10:3301`（不是 127.0.0.1），从本机 curl 要带 `-H 'Host: 127.0.0.1:3301'`，否则 403「只接受本机回环、localhost 或已配置的面板对外域名」；token 取 `/var/log/dsh-web.log` 末尾那条。

## 与上游的分工

上游仓库侧（`src/chat/hub.js` 的 `logChat`）现在会把图片段的 `{ appid, fileid, file }` 和消息 `mid` 落进聊天流水，`qq_api_call` 也开放了 `get_msg`。回看历史时要图，优先凭 `mid` 去 `get_msg` 现取；本模块的 `qq_peek_group` 负责「一次翻一大段、顺手把图链续好」这种批量场景。
