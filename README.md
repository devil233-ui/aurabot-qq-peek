# aurabot-mod-qq-peek 🔭

Aurabot（DSH 的 QQ 插件 [`dsh-aurabot-qq`](https://github.com/aureth-labs/dsh-aurabot-qq)）的本地模块：让她能**翻别的群**的聊天记录，并且**真的要得到图**。

内置的 `qq_chat_history` 只能翻当前聊天，图片在流水里只剩 `[图片]` 占位（上游 issue [#540](https://github.com/aureth-labs/dsh-aurabot-qq/issues/540)）。这个模块补三件事：

| 工具 | 谁能用 | 做什么 |
|---|---|---|
| `qq_peek_group(group_id, count, images)` | 白名单群的会话 | 翻某个群最近 `count` 条（默认 30，**最多 1000**），每行开头 `[消息id]`；图段就地标成 `[图片#n]`，末尾统一给可下载的链接 |
| `qq_say_in_group(group, text, quote)` | 主人私聊（`level=full`）；模块设置里打开「后台回合也能发群」后，定时/后台回合也可用 | 让她去白名单群说一句话，内容原样发出；`<at:QQ号>`、`<reply:消息id>` 会被还原成真动作。走插件通道，chatlog 会留一行 `who: bot` |
| `qq_msg_info(message_id)` | 任意会话 | 查一条消息实际带了哪些段（引用 / @ / 图），发完带引用的消息拿它自查 |

## 为什么要「后台回合也能发群」

定时任务、日记、子智能体这些回合**没有人在等回复**，宿主给它们的会话是 `system` 档（`level` 落到 `social`，见 `src/chat/hub.js` 里 `chat.kind === 'system'` 那一支）。`qq_say_in_group` 原本只在「主人私聊 + `level=full`」挂载，于是这类回合里她只能绕过插件、直接打网关的 HTTP 端口发消息：话发出去了，插件不知情，`chatlog` 里自然没有副本——这就是「定时任务丢档」的根因。

打开这个开关后，`system` 回合也会挂上 `qq_say_in_group`，但她仍然**只能发 `allow.groups` 白名单里的群**，而且发送走 `api.onebot`（过插件），`chatlog` 会记一行 `who: bot`。默认关，因为它等于把「主动发群」的能力交给所有后台回合。

## 图片链接为什么要自己续 rkey

网关给的历史消息里，`image` 段自带的 `url` 是**带 rkey 的临时地址**，一小时左右就过期——拿它去下载，过一阵子就是 403。所以模块不存、也不信那个 url：

1. 从图段里取 `url` 当模板；
2. 向网关现取当前 rkey（依次试 `nc_get_rkey`、`get_rkey`、`get_rkey_server`，三种返回格式都兼容：数组按 `type=20/10` 区分群聊/私聊，`get_rkey_server` 给 `<kind>_rkey` + `expired_time`）；
3. 把 `rkey=` 换掉再交出去，**缓存提前两分钟作废**，免得给到手时刚好过期。

群聊图是 `appid=1407`，私聊 `1406`，群里的转发私聊图也可能是 `1406`，所以按 `appid` 决定取哪种 rkey。

## 安装

跟 `aurabot-mod-memory` / `aurabot-mod-mc-inject` 一样，**仓库直接检出在模块目录里**，不另找地方放代码——目录名必须和模块 id 一致（`api.use('qq-peek')` 这类消费方按名字取，不符就静默拿不到）：

```bash
git clone git@github.com:devil233-ui/aurabot-qq-peek.git \
  /root/.dsh/plugins-data/aurabot/modules/qq-peek
```

已经在跑的就是这份：`cd` 进去改、提交、`git pull` 都直接生效。宿主会在约 10 秒内热重载（日志 `[modules] 模块「qq-peek」文件改了，重新加载`），**不用重启宿主**。

### 白名单

模块读 aurabot 的顶层配置 `allow.groups`（`~/.dsh/plugins-data/aurabot/config.json`），也就是机器人本来就允许待的那些群，不另起一份名单：

```json
{ "allow": { "groups": ["<群号>", "<群号>"] } }
```

群名不写死在代码里：启动时用 `get_group_list` 取一次网关的群名做别名，群名和群号都能用来指代。改完白名单要重启宿主（`config.json` 不进热重载）。

## 边界

- **只读**：翻记录不改群、不进群、不发言。
- **发言**只在主人私聊且 `level=full` 时可用，目标必须是白名单群；带段发送失败会自动退回纯文字，不会整条发不出去。
- 这里没有「识图」：拿到的是可下载的链接，看不看得懂图取决于 aurabot 的 `model.vision` 配置。

## 许可

MIT，见 [LICENSE](LICENSE)。
