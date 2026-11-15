// discord-bridge · v0.1
//
// 一条线，两个方向：
//   收：定时用 bot token 拉一个 Discord 频道的消息 → 新消息投进【这个会话】
//   发：discord_reply 工具 → POST 回同一个频道
//
// 不新建会话、不生成分身：消息直接落进写死的目标会话，回答由同一个我写。
// 配置放在 tmp\discord-bridge.json，每一轮重新读，改配置不用重载插件。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { request as httpsRequest, Agent } from 'node:https'

// 复用连接：不开 keep-alive 的话每 10 秒都要重做一次 TLS 握手
const keepAlive = new Agent({ keepAlive: true, maxSockets: 2 })

export const name = 'discord-bridge'
export const inject = ['sessionController', 'tools']

const CFG = {
  configFile: 'D:\\DeepSeek\\workspace\\tmp\\discord-bridge.json',
  stateFile: 'D:\\DeepSeek\\workspace\\tmp\\discord-seen.json',
  // 写死：消息只进这一个会话
  targetSessionId: 'session-516b3fba-9c28-48e0-a105-121abf8ee88e',
  pollMs: 10000,
  host: 'discord.com',
}

const log = (...a) => console.log('[discord-bridge]', ...a)
const warn = (...a) => { console.warn('[discord-bridge]', ...a); fileLog('warn', a.join(' ')) }

// 宿主进程的 console 我看不到，出错必须落盘，否则桥死掉是无声的
const LOGFILE = 'D:\\DeepSeek\\workspace\\tmp\\discord-bridge.log'
function fileLog(kind, msg) {
  try {
    mkdirSync(dirname(LOGFILE), { recursive: true })
    const stat = (() => { try { return readFileSync(LOGFILE, 'utf8').length } catch { return 0 } })()
    if (stat > 400000) writeFileSync(LOGFILE, '', 'utf8')
    writeFileSync(LOGFILE, new Date().toISOString() + ' [' + kind + '] ' + String(msg).slice(0, 2000) + '\n', { flag: 'a' })
  } catch {}
}

let ctxRef = null
let disposed = false
let primed = false
let lastId = ''
let lastPollAt = 0
let lastError = ''
let targetKind = ''
let targetChannelId = ''
const seen = new Set()
const attempts = new Map()

function loadCfg() {
  try {
    const c = JSON.parse(readFileSync(CFG.configFile, 'utf8'))
    if (!c || typeof c !== 'object') return null
    return c
  } catch {
    return null
  }
}

function loadState() {
  try {
    const j = JSON.parse(readFileSync(CFG.stateFile, 'utf8'))
    if (typeof j.lastId === 'string' && j.lastId) { lastId = j.lastId; primed = true }
    for (const id of j.seen || []) seen.add(id)
    return primed
  } catch {
    return false
  }
}

function saveState() {
  try {
    mkdirSync(dirname(CFG.stateFile), { recursive: true })
    writeFileSync(CFG.stateFile, JSON.stringify({
      lastId,
      seen: [...seen].slice(-300),
    }, null, 2), 'utf8')
  } catch (err) { warn('saveState failed:', err?.message) }
}

// 一次 HTTPS 请求。429 当「这轮没消息」处理，下一轮再来。
function api(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = {
      Authorization: 'Bot ' + token,
      'User-Agent': 'DiscordBot (https://github.com/T0086/beacon, 0.1)',
    }
    if (payload) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = payload.length
    }
    const req = httpsRequest({ host: CFG.host, path: '/api/v10' + path, method, headers, timeout: 15000, agent: keepAlive }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const code = res.statusCode || 0
        if (code >= 200 && code < 300) {
          try { resolve(text ? JSON.parse(text) : null) } catch (err) { reject(err) }
          return
        }
        if (code === 429) { resolve([]); return }
        reject(new Error('discord ' + code + ': ' + text.slice(0, 300)))
      })
    })
    req.on('timeout', () => req.destroy(new Error('discord timeout')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function flatten(message) {
  const parts = []
  if (typeof message.content === 'string' && message.content.trim()) parts.push(message.content.trim())
  // 贴纸、嵌入、附件都是「有内容但 content 为空」的消息，漏掉等于静默吞掉
  const stickers = Array.isArray(message.stickers) ? message.stickers : []
  for (const s of stickers) parts.push('[贴纸 ' + (s.name || s.id || 'sticker') + ']')
  const embeds = Array.isArray(message.embeds) ? message.embeds : []
  for (const e of embeds) parts.push('[嵌入 ' + (e.title || e.description || 'embed') + ']')
  const atts = Array.isArray(message.attachments) ? message.attachments : []
  for (const a of atts) parts.push('[附件 ' + (a.filename || 'file') + '] ' + (a.url || ''))
  return parts.join('\n')
}

// 把一批消息压成一段最短的提示：一行头 + 正文 + 一行回法。
// 多条挤在同一轮里投，别让每条消息各叫醒一次。
function composeInbound(items, kindLabel, hint) {
  const rows = []
  for (const it of items) {
    const text = (it.text || '').trim()
    if (!text) continue
    rows.push({ at: it.at || '', name: it.name || 'someone', text })
  }
  if (rows.length === 0) return ''
  const who = rows[0].name
  const span = rows.length === 1
    ? rows[0].at
    : (rows[0].at || '') + '~' + (rows[rows.length - 1].at || '')
  const head = '[discord/' + kindLabel + '] ' + who + (span ? ' ' + span : '') +
    (rows.length > 1 ? '（' + rows.length + ' 条）' : '')
  const body = rows.length === 1
    ? rows[0].text
    : rows.map((r) => '- ' + (r.at ? r.at + ' ' : '') + r.text).join('\n')
  const tail = hint === undefined ? '↩ discord_reply，短句纯文本' : hint
  return tail ? head + '\n' + body + '\n' + tail : head + '\n' + body
}

function hhmm(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

async function deliver(text) {
  const ac = new AbortController()
  await ctxRef.sessionController.prompt({
    requestId: 'discord-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    sessionId: CFG.targetSessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  }, ac.signal)
}

// 只有 token 的时候自己找频道：bot 在哪个服务器、哪个文字频道、该看谁发的消息。
// 找到就把 channelId 写回配置文件，之后不用再找。
async function discoverChannel(token) {
  const guilds = await api('GET', '/users/@me/guilds', token)
  if (!Array.isArray(guilds) || guilds.length === 0) {
    throw new Error('bot 还没进任何服务器（先把它邀请进去）')
  }
  for (const g of guilds) {
    let chans = []
    try { chans = await api('GET', '/guilds/' + g.id + '/channels', token) } catch { continue }
    const text = (Array.isArray(chans) ? chans : []).filter((c) => c && c.type === 0)
    if (text.length === 0) continue
    const pick = text.find((c) => /beacon|dsh/i.test(c.name || '')) || text[0]
    return { channelId: pick.id, guildName: g.name || g.id, channelName: pick.name || pick.id }
  }
  throw new Error('这些服务器里没有文字频道')
}

function persistChannel(cfg, channelId) {
  try {
    const next = { ...cfg, channelId }
    writeFileSync(CFG.configFile, JSON.stringify(next, null, 2), 'utf8')
    return true
  } catch (err) {
    warn('persistChannel failed:', err?.message)
    return false
  }
}

// 改配置文件里的一个键（发现结果落盘，重载后不用重找）
function persistKey(name, value) {
  try {
    const cfg = loadCfg() || {}
    if (cfg[name] === value) return true
    cfg[name] = value
    writeFileSync(CFG.configFile, JSON.stringify(cfg, null, 2), 'utf8')
    return true
  } catch (err) {
    warn('persistKey failed:', err?.message)
    return false
  }
}

// 私信频道：POST /users/@me/channels 建一次就长期有效，之后复用。
// 注意 Discord 的硬限制：bot 和用户必须共处同一个服务器，否则建不了私信。
async function openDmChannel(cfg) {
  if (cfg.dmChannelId) return cfg.dmChannelId
  const dm = await api('POST', '/users/@me/channels', cfg.token, { recipient_id: cfg.dmUserId })
  const id = dm && dm.id
  if (id) persistKey('dmChannelId', id)
  return id || ''
}

// 这轮往哪儿读、往哪儿发：preferDm + 知道对方 user id 就走私信，否则走频道
async function resolveTarget(cfg) {
  if (cfg.dmUserId && cfg.preferDm) {
    try {
      const dmId = await openDmChannel(cfg)
      if (dmId) return { channelId: dmId, kind: 'dm' }
    } catch (err) {
      lastError = String(err?.message || err)
      warn('open dm failed:', lastError)
    }
  }
  return { channelId: cfg.channelId, kind: 'channel' }
}

// 离线兜底 / 自测：inboxFile 里一行算一条消息，投完就把文件清空。
// Discord 掉线、或者还没配好 token 的时候，这条路照样能把消息叫醒我。
async function drainInbox(cfg) {
  const file = typeof cfg.inboxFile === 'string' ? cfg.inboxFile : ''
  if (!file) return
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return }
  if (!text.trim()) return
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  writeFileSync(file, '', 'utf8')
  // 兜底也合并成一轮，别一行叫醒一次
  const body = composeInbound(lines.map((l) => ({ name: '本机兜底', at: '', text: l })), '兜底', '')
  if (!body) return
  try {
    await deliver(body)
    log('inbox delivered:', lines.length, 'line(s)')
  } catch (err) {
    lastError = String(err?.message || err)
    warn('inbox deliver failed:', lastError)
  }
}

async function poll() {
  if (disposed) return
  lastPollAt = Date.now()
  let cfg = loadCfg()
  if (!cfg) return
  try { await drainInbox(cfg) } catch (err) { warn('drainInbox error:', String(err?.message || err)) }
  // 网关就绪就不再打 REST；轮询退成兜底
  if (gw.status === 'ready') return
  if (!cfg.token) return
  // 只给了 token 就自己找频道，找到后写回配置
  if (!cfg.channelId && cfg.autoDiscover !== false) {
    try {
      const found = await discoverChannel(cfg.token)
      if (persistChannel(cfg, found.channelId)) {
        cfg = { ...cfg, channelId: found.channelId }
        log('discovered channel:', found.guildName, '/', found.channelName, '->', found.channelId)
        lastError = ''
      }
    } catch (err) {
      lastError = String(err?.message || err)
      return
    }
  }
  if (!cfg.channelId) return
  // 走频道还是走私信，由 resolveTarget 决定（只看一次，别在循环里反复建）
  let target
  try {
    target = await resolveTarget(cfg)
  } catch (err) {
    lastError = String(err?.message || err)
    return
  }
  if (!target.channelId) return
  targetKind = target.kind
  targetChannelId = target.channelId
  try {
    const query = primed && lastId ? '?after=' + lastId + '&limit=20' : '?limit=1'
    const msgs = await api('GET', '/channels/' + target.channelId + '/messages' + query, cfg.token)
    if (!Array.isArray(msgs) || msgs.length === 0) {
      if (!primed) { primed = true }
      lastError = ''
      return
    }
    const newest = msgs[0] && msgs[0].id
    if (!primed) {
      // 首轮只建基线：历史消息不投
      lastId = newest || lastId
      primed = true
      saveState()
      log('baseline set at', lastId)
      return
    }
    const allow = Array.isArray(cfg.allowedUserIds) ? cfg.allowedUserIds : []
    const fresh = msgs
      .filter((m) => !(m.author && m.author.bot))
      .filter((m) => !seen.has(m.id))
      .filter((m) => allow.length === 0 || allow.includes(m.author && m.author.id))
      .reverse() // Discord 给的是新→旧，按时间正序投
    // 顺手认人：第一次见到真人发言就记下 user id，之后就能走私信
    if (!cfg.dmUserId) {
      const human = fresh.find((m) => m.author && !m.author.bot)
      if (human) {
        persistKey('dmUserId', human.author.id)
        cfg = { ...cfg, dmUserId: human.author.id }
        log('learned dmUserId:', human.author.id)
      }
    }
    for (const m of fresh) {
      if (!flatten(m)) seen.add(m.id)
    }
    const pending = fresh.filter((m) => flatten(m) && (attempts.get(m.id) || 0) < 5)
    if (pending.length) {
      const body = composeInbound(pending.map((m) => ({
        at: hhmm(m.timestamp),
        name: (m.author && (m.author.global_name || m.author.username)) || 'someone',
        text: flatten(m),
      })), target.kind === 'dm' ? '私信' : '频道')
      try {
        await deliver(body)
        for (const m of pending) {
          seen.add(m.id)
          attempts.delete(m.id)
        }
        lastError = ''
        log('inbound:', pending.length, 'msg ->', body.slice(0, 60))
      } catch (err) {
        for (const m of pending) attempts.set(m.id, (attempts.get(m.id) || 0) + 1)
        lastError = String(err?.message || err)
        warn('deliver failed:', lastError)
      }
    }
    // 投失败的这批不推进游标，下一轮还会被 after=lastId 捞出来重试
    if (newest && !(pending.length && lastError)) lastId = newest
    saveState()
  } catch (err) {
    lastError = String(err?.message || err)
    warn('poll failed:', lastError)
  }
}

// ---------------------------------------------------------------- gateway
// 推送优先：Gateway WebSocket 连上就用事件推，线上一有消息立刻到；
// 连不上（或宿主没有 WebSocket）就退回 REST 轮询，保证不断联。
const BASE_INTENTS = (1 << 0) | (1 << 9) | (1 << 12)
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES
const FULL_INTENTS = BASE_INTENTS | (1 << 15) // + MESSAGE_CONTENT（特权，要在开发者页手开）
let gwIntents = FULL_INTENTS

const gw = {
  ws: null,
  status: 'idle', // idle | connecting | open | ready | down | no-ws
  sessionId: '',
  resumeUrl: '',
  seq: 0,
  botId: '',
  heartbeatTimer: null,
  acked: true,
  attempts: 0,
  closing: false,
  lastEventAt: 0,
  connects: 0,
}
let gwBatch = []
let gwBatchTimer = null

const transport = () => (gw.status === 'ready' ? 'gateway' : 'poll')

function gwSend(payload) {
  try {
    if (gw.ws && gw.ws.readyState === 1) gw.ws.send(JSON.stringify(payload))
  } catch (err) { warn('ws send failed:', err?.message) }
}

async function gatewayUrl(token) {
  const r = await api('GET', '/gateway/bot', token)
  return (r && r.url) || 'wss://gateway.discord.gg'
}

function gwStopTimer() {
  if (gw.heartbeatTimer) { clearInterval(gw.heartbeatTimer); gw.heartbeatTimer = null }
}

function gwRestart(hard) {
  gwStopTimer()
  gw.closing = true
  try { if (gw.ws) gw.ws.close() } catch {}
  gw.ws = null
  gw.status = 'down'
  if (hard) { gw.sessionId = ''; gw.seq = 0; gw.resumeUrl = '' }
  gw.attempts = Math.min(gw.attempts + 1, 6)
  const delay = Math.min(30000, 1000 * Math.pow(2, gw.attempts))
  log('gateway reconnect in', delay, 'ms (hard=' + Boolean(hard) + ')')
  setTimeout(() => { gw.closing = false; void connectGateway() }, delay)
}

function gwHeartbeat() {
  if (!gw.ws) return
  if (!gw.acked) {
    warn('gateway heartbeat unacked, reconnecting')
    gwRestart(false)
    return
  }
  gw.acked = false
  gwSend({ op: 1, d: gw.seq || null })
}

async function connectGateway() {
  if (disposed) return
  const cfg = loadCfg()
  if (!cfg || !cfg.token) { gw.status = 'idle'; return }
  if (typeof WebSocket === 'undefined') {
    gw.status = 'no-ws'
    warn('no global WebSocket in this runtime; staying on REST polling')
    return
  }
  // 降级之后每 5 分钟试着升回完整意图：你在开发者页打开开关后，不用重载插件也能自愈
  if (gwIntents !== FULL_INTENTS && gw.downgradedAt && Date.now() - gw.downgradedAt > 300000) {
    gwIntents = FULL_INTENTS
    gw.downgradedAt = 0
    log('retrying full intents (MESSAGE_CONTENT may now be enabled)')
  }
  try {
    const base = gw.resumeUrl || (await gatewayUrl(cfg.token))
    const sep = base.includes('?') ? '&' : '?'
    const ws = new WebSocket(base + sep + 'v=10&encoding=json')
    gw.ws = ws
    gw.status = 'connecting'
    gw.connects += 1

    ws.addEventListener('open', () => {
      if (gw.closing) return
      gw.status = 'open'
      log('gateway socket open')
    })

    ws.addEventListener('message', (ev) => { onGatewayMessage(ev.data, cfg.token) })

    log('gateway dial', base)
    ws.addEventListener('error', (ev) => { warn('gateway error event:', (ev && (ev.message || ev.error && ev.error.message)) || 'no detail') })

    ws.addEventListener('close', (ev) => {
      if (gw.closing) { gw.closing = false; return }
      gw.status = 'down'
      warn('gateway socket closed code=' + (ev && ev.code) + ' reason=' + (ev && ev.reason ? String(ev.reason).slice(0, 120) : ''))
      if (ev && ev.code === 4014 && gwIntents !== BASE_INTENTS) {
        gwIntents = BASE_INTENTS
        gw.downgradedAt = Date.now()
        gw.intentNote = 'MESSAGE_CONTENT 未开启：开发者页 -> Bot -> Privileged Gateway Intents'
        warn('intent downgraded:', gw.intentNote)
        gw.attempts = 0
      }
      gwRestart(false)
    })
  } catch (err) {
    warn('gateway connect failed:', String(err?.message || err))
    gwRestart(false)
  }
}

function onGatewayMessage(raw, token) {
  let msg = null
  try { msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) } catch { return }
  if (!msg || typeof msg.op !== 'number') return
  if (typeof msg.s === 'number') gw.seq = msg.s

  switch (msg.op) {
    case 10: { // hello
      gw.acked = true
      const iv = (msg.d && msg.d.heartbeat_interval) || 41250
      gwStopTimer()
      gw.heartbeatTimer = setInterval(gwHeartbeat, iv)
      log('gateway hello, heartbeat', iv, 'ms')
      if (gw.sessionId && gw.seq) {
        gwSend({ op: 6, d: { token, session_id: gw.sessionId, seq: gw.seq } })
        log('gateway resume attempt at seq', gw.seq)
      } else {
        gwSend({ op: 2, d: {
          token,
          intents: gwIntents,
          properties: { os: 'windows', browser: 'dsh-discord-bridge', device: 'dsh-discord-bridge' },
        } })
        log('gateway identify sent, intents', gwIntents)
      }
      break
    }
    case 11: gw.acked = true; break
    case 1: gwHeartbeat(); break
    case 7: log('gateway asked reconnect'); gwRestart(false); break
    case 9:
      warn('gateway invalid session, resumable=' + Boolean(msg.d))
      if (msg.d) gwRestart(false)
      else { gw.sessionId = ''; gw.seq = 0; gw.resumeUrl = ''; gwRestart(true) }
      break
    case 0: onGatewayDispatch(msg.t, msg.d); break
    default: break
  }
}

function onGatewayDispatch(type, data) {
  gw.lastEventAt = Date.now()
  if (type === 'READY') {
    gw.status = 'ready'
    gw.sessionId = data.session_id || ''
    gw.resumeUrl = String(data.resume_gateway_url || '').replace(/\/$/, '')
    gw.botId = (data.user && data.user.id) || ''
    gw.attempts = 0
    lastError = ''
    if (gwIntents === FULL_INTENTS) gw.intentNote = ''
    log('gateway ready as', data.user && data.user.username, 'session', gw.sessionId.slice(0, 8))
    return
  }
  if (type === 'RESUMED') {
    gw.status = 'ready'
    gw.attempts = 0
    log('gateway resumed')
    return
  }
  if (type === 'MESSAGE_CREATE') { onGatewayMessageCreate(data); return }
}

function onGatewayMessageCreate(m) {
  if (!m || !m.author) return
  if (m.author.bot) return
  if (gw.botId && m.author.id === gw.botId) return
  const cfg = loadCfg()
  if (!cfg) return
  const isDm = Boolean(cfg.dmChannelId) && m.channel_id === cfg.dmChannelId
  const isCh = Boolean(cfg.channelId) && m.channel_id === cfg.channelId
  if (!isDm && !isCh) return
  const allow = Array.isArray(cfg.allowedUserIds) ? cfg.allowedUserIds : []
  if (allow.length && !allow.includes(m.author.id)) return
  if (seen.has(m.id)) return

  // 顺手认人，之后回复可以走私信
  if (!cfg.dmUserId && m.author.id) {
    persistKey('dmUserId', m.author.id)
    log('learned dmUserId:', m.author.id)
  }
  const body = flatten(m)
  if (!body) {
    // 收到事件但正文为空：九成是 MESSAGE_CONTENT 没开，别静默吞掉
    warn('gateway message with empty content (MESSAGE_CONTENT off?) id=' + m.id)
    return
  }
  seen.add(m.id)
  gwBatch.push({
    at: hhmm(m.timestamp),
    name: (m.author.global_name || m.author.username) || 'someone',
    text: body,
  })
  saveState()
  if (!gwBatchTimer) {
    gwBatchTimer = setTimeout(() => { void flushGatewayBatch(isDm ? 'dm' : 'channel') }, 1200)
  }
}

async function flushGatewayBatch(kind) {
  gwBatchTimer = null
  const items = gwBatch
  gwBatch = []
  if (items.length === 0) return
  const body = composeInbound(items, kind === 'dm' ? '私信' : '频道')
  if (!body) return
  try {
    await deliver(body)
    lastError = ''
    log('gateway inbound:', items.length, 'msg ->', body.slice(0, 50))
  } catch (err) {
    lastError = String(err?.message || err)
    warn('gateway deliver failed:', lastError)
  }
}

async function loop() {
  // 配置还没写、或者刚改过，都靠每轮重读来感知
  while (!disposed) {
    try {
      await poll()
    } catch (err) {
      // 一轮坏掉不能让整条桥永久停止：记下来，下一轮照跑
      warn('loop error:', String(err?.message || err), String(err?.stack || ''))
    }
    await new Promise((r) => setTimeout(r, CFG.pollMs))
  }
}

async function sendToDiscord(text) {
  const cfg = loadCfg()
  if (!cfg || !cfg.token) throw new Error('还没配置：tmp\\discord-bridge.json 缺 token')
  const target = await resolveTarget(cfg)
  if (!target.channelId) throw new Error('还没找到频道，等发现完成再发')
  const body = String(text).slice(0, 1900)
  const res = await api('POST', '/channels/' + target.channelId + '/messages', cfg.token, { content: body })
  if (res && res.id) seen.add(res.id) // 自己发的不要回灌
  return { ok: true, id: res && res.id ? res.id : '' }
}

export function apply(ctx) {
  ctxRef = ctx

  try {
    ctx.tools.register(defineTool({
      name: 'discord_reply',
      description: '把一段纯文本发到 KJ 的 Discord 频道。只在回答「来自 Discord」的消息时用；不要带 Markdown。',
      parameters: {
        text: { type: 'string', required: true, description: '要发回 Discord 的纯文本。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, id: { type: 'string' } },
        },
        render(_args, value) {
          if (!value || value.ok === false) return [{ type: 'text', text: '✗ 没发出去' }]
          return [{ type: 'text', text: '✓ 已发到 Discord' }]
        },
      },
      async execute(args) {
        return sendToDiscord(args.text)
      },
    }))

    ctx.tools.register(defineTool({
      name: 'discord_status',
      description: '看 Discord 桥的当前状态：配没配好、上次轮询时间、最近一次错误、游标位置。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            configured: { type: 'boolean' },
            channelId: { type: 'string' },
            targetKind: { type: 'string' },
            dmUserId: { type: 'string' },
            inboxFile: { type: 'string' },
            sessionId: { type: 'string' },
            lastId: { type: 'string' },
            transport: { type: 'string' },
            gateway: { type: 'string' },
            lastPollAt: { type: 'string' },
            lastError: { type: 'string' },
            seen: { type: 'number' },
          },
        },
        render(_args, value) {
          const v = value || {}
          const lines = [
            (v.configured ? '✓ 已配置' : '✗ 未配置'),
            '传输 ' + (v.transport === 'gateway' ? 'Gateway 推送' : 'REST 轮询') + (v.gateway ? ' · ' + v.gateway : ''),
            '通道 ' + (v.channelId || '-') + (v.targetKind ? '（' + (v.targetKind === 'dm' ? '私信' : '频道') + '）' : ''),
            '对方 user id ' + (v.dmUserId || '还没认出来'),
            '会话 ' + v.sessionId,
            '游标 ' + (v.lastId || '-'),
            '上次轮询 ' + (v.lastPollAt || '-'),
            v.lastError ? '最近错误 ' + v.lastError : '',
          ].filter(Boolean)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute() {
        const cfg = loadCfg()
        return {
          configured: Boolean(cfg && cfg.token && cfg.channelId),
          channelId: targetChannelId || (cfg && cfg.channelId ? cfg.channelId : ''),
          targetKind,
          dmUserId: cfg && cfg.dmUserId ? cfg.dmUserId : '',
          inboxFile: cfg && cfg.inboxFile ? cfg.inboxFile : '',
          sessionId: CFG.targetSessionId,
          lastId,
          transport: transport(),
          gateway: gw.status + (gw.sessionId ? ' · session ' + gw.sessionId.slice(0, 8) : '') + ' · connects ' + gw.connects + (gw.intentNote ? ' · ⚠ ' + gw.intentNote : ''),
          lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : '',
          lastError,
          seen: seen.size,
        }
      },
    }))
    log('tools registered: discord_reply, discord_status')
  } catch (err) {
    warn('register tools failed:', String(err?.message || err))
  }

  loadState()
  fileLog('info', 'node ' + process.versions.node + ' · WebSocket=' + (typeof WebSocket) + ' · transport=gateway-first')
  void connectGateway()
  void loop()

  // 独立定时器：连接健康时 connectGateway 不会被再调，意图升回必须自己起个闹钟
  setInterval(() => {
    if (disposed) return
    if (gwIntents === FULL_INTENTS) return
    if (!gw.downgradedAt || Date.now() - gw.downgradedAt < 300000) return
    log('intent upgrade attempt (60s tick)')
    gwIntents = FULL_INTENTS
    gw.downgradedAt = 0
    gw.attempts = 0
    gwRestart(true)
  }, 60000)
  log('watching discord channel, poll', CFG.pollMs, 'ms')

  ctx.effect(() => () => {
    disposed = true
  })
}
