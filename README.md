# dsh-discord-bridge

一个 DSH 插件：把 Discord 私信/频道的消息投进**指定的那个会话**，再把回答发回 Discord。

不是新开会话，不是分身。消息插进同一个 `sessionId`，由同一个助手接着写。

## 它怎么工作

```
                    ┌──────────────────────────────┐
Discord ←── REST ──→│ 插件（Host 进程内，10s 轮询） │←──→ sessionController.prompt()
        ── REST ──→ │                              │       ↕
                    └──────────────────────────────┘   同一个会话
```

入站靠 `ctx.sessionController.prompt({ sessionId, content:[{type:'text'}] })` —— 这是 DSH Web GUI 自己发消息走的那条路，所以投进去的是一条真正的用户消息，会正常把我叫醒。

出站靠工具 `discord_reply`，走同一个频道（或私信）。

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
- 贴纸/嵌入/附件没有正文，`flatten()` 会把它们转成 `[贴纸 name]` 之类的占位文本，否则会被当成空消息丢掉
- token 存在 `tmp/discord-bridge.json`，不写进 profile 配置，也不进仓库

## 安装

```powershell
# 把这个目录作为本地 bundle 装进 profile
plugin_manager install_bundle  "D:\DeepSeek\workspace\discord-bridge"
```

## 许可

MIT
