# dsh-discord-bridge

一个 DSH 插件：把 Discord 私信/频道的消息投进**指定的那个会话**，再把回答发回 Discord。

不是新开会话，不是分身。消息插进同一个 `sessionId`，由同一个助手接着写。

## 它怎么工作

```
                    ┌────────────────────────────────┐
Discord ←─ REST ────│ 插件（Host 进程内）             │←──→ sessionController.prompt()
        ←─ Gateway ─│ 推送优先，轮询兜底              │       ↕
                    └────────────────────────────────┘   同一个会话
```

传输层两种模式，自动切换：

| 模式 | 状态 | 延迟 | 开销 |
|---|---|---|---|
| **Gateway 推送** | 首选 | <1 秒 | 一条常连 + 41 秒心跳 |
| REST 轮询 | 网关连不上时兜底 | 0–10 秒 | 10 秒一次 GET |

网关断线、心跳无 ack、op 7 / op 9，都会自己重连（指数退避，最长 30 秒）；能 resume 就带 `session_id` + `seq` 续上，续不上就重新 identify。

入站靠 `ctx.sessionController.prompt({ sessionId, content:[{type:'text'}] })` —— 这是 DSH Web GUI 自己发消息走的那条路，所以投进去的是一条真正的用户消息，会正常把我叫醒。

出站靠工具 `discord_reply`，走同一个频道（或私信）。

## 必须有的一步：MESSAGE_CONTENT

Gateway 要拿到消息正文，必须在开发者页打开特权意图：

https://discord.com/developers/applications/<APP_ID>/bot → **Privileged Gateway Intents** → 勾 **MESSAGE CONTENT INTENT** → Save Changes

不打开会怎样：连接被 4014 Disallowed intent(s) 拒绝。插件会自动降到基础意图重连（能收事件、但正文为空），并在 discord_status 里挂一行警告；之后每 5 分钟自动试一次升回完整意图，你开完开关不用重载插件。

另外两个（PRESENCE / SERVER MEMBERS）不需要，开了反而在 100 个服务器以上会被平台卡住。

## 首次配置

1. 在 https://discord.com/developers/applications 建一个应用，`Bot` 页 `Reset Token` 拿 token
2. 用带 `bot` scope 的邀请链接把它请进一个服务器（权限：View Channels / Send Messages / Read Message History = 68608）
3. 写 `tmp/discord-bridge.json`：

```json
{
  "token": "你的 bot token",
  "preferDm": true,
  "inboxFile": "D:\\DeepSeek\\workspace\\tmp\\discord-inbox.txt"
}
```

只给 token 也够：插件会自己 `GET /users/@me/guilds` 找服务器、找文字频道，写回 `channelId`。你在频道里说一句话，它就从 `author.id` 认出你，`POST /users/@me/channels` 建私信，之后全走私信。

`sessionId` 写死在 `index.js` 的 `CFG.targetSessionId`，因为「同一个我」是这个插件的全部意义，不该可配。

## 投进会话的格式

多条消息合并成一轮，而不是一条一次叫醒：

```
[discord/私信] T0086 14:30
能听到这句吗
↩ discord_reply，短句纯文本
```

连着发好几句时：

```
[discord/私信] T0086 14:30~14:31（3 条）
- 14:30 在吗
- 14:31 帮我看个东西
- 14:31 [贴纸 猫猫]
↩ discord_reply，短句纯文本
```

头部只有一件事：来源（私信/频道）、谁、什么时候。回复方式压成一行，不再每条消息重复一段说明。

## 工具

| 工具 | 作用 |
|---|---|
| `discord_reply` | 把纯文本发回 Discord（自动选私信或频道） |
| `discord_status` | 看有没有配好、走的哪条通道、游标、上次轮询、最近错误 |

## 离线兜底

`inboxFile` 里一行算一条消息，投完清空。Discord 掉线或还没配 token 时，这条路照样能叫醒会话——也是自测入口。

## 已知边界

- 只有 PC 开着才通；插件活在 DSH 进程里
- 轮询 10 秒，延迟最坏一轮
- 消息按 `queue` 投递：助手忙着时会等当前这一轮结束
- **一轮对话正在生成时，轮询会停在这轮里**，等这一轮结束才继续；期间你发的消息不会丢，下一轮一起进来
- 出错会写 `tmp/discord-bridge.log`；宿主进程的 stdout 拿不到，不落盘就等于桥静默死掉
- 贴纸/嵌入/附件没有正文，`flatten()` 会把它们转成 `[贴纸 name]` 之类的占位文本，否则会被当成空消息丢掉
- token 存在 `tmp/discord-bridge.json`，不写进 profile 配置，也不进仓库

## 安装

```powershell
# 把这个目录作为本地 bundle 装进 profile
plugin_manager install_bundle  "D:\DeepSeek\workspace\discord-bridge"
```

## 许可

MIT
