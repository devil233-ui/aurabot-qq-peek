/** @type {import('../aurabot').AurabotModule} */
// 让她能主动翻「别的群」的聊天记录（内置 qq_chat_history 只能翻当前聊天）
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const LABEL = { image: '[图片]', face: '[表情]', mface: '[表情]', record: '[语音]', video: '[视频]', file: '[文件]', forward: '[合并转发]' }

function segText(seg, self) {
  const t = seg?.type
  const d = seg?.data ?? {}
  if (t === 'text') return d.text ?? ''
  if (t === 'at') return String(d.qq) === self ? '@你' : '@' + (d.name || d.qq || '某人')
  if (t === 'reply') return ''
  if (t === 'json' || t === 'xml') return '[卡片]'
  return LABEL[t] ?? ''
}

// ---- 图片链接：历史里图片段自带 url，但 rkey 会过期，回看时得自己续上 ----
const RKEY_ACTIONS = ['nc_get_rkey', 'get_rkey', 'get_rkey_server']
const rkeyCache = new Map()

function normRkey(v) {
  return String(v ?? '').replace(/^&?rkey=/, '')
}

// 三种回法都兼容：get_rkey 是数组，nc_get_rkey 的 type 是 10/20，get_rkey_server 给 *_rkey + expired_time
function pickRkey(resp, kind) {
  const d = resp?.data ?? resp
  if (Array.isArray(d)) {
    const want = kind === 'group' ? ['group', 20] : ['private', 10]
    const hit = d.find((x) => want.includes(x?.type))
    return hit?.rkey ? { rkey: normRkey(hit.rkey), ttl: Number(hit.ttl) || 0 } : null
  }
  const raw = d?.[`${kind}_rkey`]
  if (!raw) return null
  const expire = Number(d?.expired_time) || 0
  return { rkey: normRkey(raw), ttl: expire ? Math.max(0, expire - Math.floor(Date.now() / 1000)) : 0 }
}

async function rkeyOf(api, kind) {
  const hit = rkeyCache.get(kind)
  if (hit && hit.exp > Date.now()) return hit.rkey
  for (const action of RKEY_ACTIONS) {
    try {
      const got = pickRkey(await api.onebot(action, {}, { timeoutMs: 5000 }), kind)
      if (!got?.rkey) continue
      // 提前两分钟作废，免得到点时刚好过期
      const ttl = (got.ttl > 0 ? got.ttl : 300) - 120
      rkeyCache.set(kind, { rkey: got.rkey, exp: Date.now() + Math.max(30, ttl) * 1000 })
      return got.rkey
    } catch { /* 换下一个 action */ }
  }
  return ''
}

// 群聊图 appid=1407，私聊 1406（群里转发的私聊图也可能是 1406）
function urlKind(url) {
  return /[?&]appid=1406\b/.test(url) ? 'private' : 'group'
}

function withRkey(url, rkey) {
  if (!rkey) return url
  return /[?&]rkey=/.test(url)
    ? url.replace(/([?&])rkey=[^&]*/, `$1rkey=${rkey}`)
    : url + (url.includes('?') ? '&' : '?') + 'rkey=' + rkey
}

// 「这条是我说的话」——传给 hub 的留痕标记。hub 只有看到 proactive 才在目标群 chatlog 补一条 bot 记录；
// 缺了它，模块发的消息在 chatlog 里零命中（回看历史时这段对话等于没发生过）。
const SAY_LOGGED = { proactive: true, proactiveCause: 'qq_say_in_group' }

// ---- 忙时排队（后台回合发群用）----
// 后台回合没人在等，硬插进一个正热闹的群只会打断对话，所以先排着，等那个群安静再补发。
// 口径照 dsh-plugin-autonomy 的 outbox：等她接话 / 她刚说过话都算忙，超时作废（晚发比乱发更糟）。
const OUTBOX_MAX = 20
const OUTBOX_ATTEMPTS = 3
const WAITING_MS = 10 * 60_000   // 只有最近这么久的入站才算「有人在等她接话」，更早的不堵
const COOLDOWN_MS = 3 * 60_000   // 她刚在同一群说过话，这么久内算「她还在那个群说话」

function loadOutbox(file, log) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    const items = parsed
      .filter((x) => x && x.id && x.gid && typeof x.body === 'string')
      // 上次扫描到一半进程没了：sending 的退回去重新排，别让它永远挂着
      .map((x) => (x.status === 'sending' ? { ...x, status: 'pending' } : x))
    return trimOutbox(items)
  } catch (e) {
    if (e?.code !== 'ENOENT') log?.warn?.(`排队文件读不出来，已忽略旧内容：${e?.message ?? e}`)
    return []
  }
}

function saveOutbox(file, items, log) {
  try {
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(items), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, file)
  } catch (e) {
    log?.warn?.(`排队文件写不进去：${e?.message ?? e}`)
  }
}

/** 只丢已结案的旧条目；待发的一条都不丢。 */
function trimOutbox(items, max = OUTBOX_MAX) {
  if (items.length <= max) return [...items]
  const pending = items.filter((x) => x.status === 'pending' || x.status === 'sending')
  const done = items.filter((x) => x.status !== 'pending' && x.status !== 'sending')
  const keepDone = Math.max(0, max - pending.length)
  return [...(keepDone ? done.slice(-keepDone) : []), ...pending]
}

function imageUrlOf(seg) {
  const d = seg?.data ?? {}
  const u = d.url || d.file_url
  return typeof u === 'string' && /^https?:\/\//.test(u) ? u : ''
}

export default {
  id: 'qq-peek',
  name: '跨群看一眼·喊她说话',
  version: '0.4.0',
  api: 1,
  description: '翻白名单群的聊天记录（只读）；主人私聊里还能喊她去指定群说一句话；开关打开后后台回合也能发群，遇到群里正热闹就排队等安静再发',
  // 模块设置：面板「模块」页按这里的声明自动生成表单，值存进 config.ext['qq-peek']
  defaults: {
    sayInBackground: false,
    queueWhenBusy: true,
    queueTtlMinutes: 10,
  },
  settings: [
    {
      key: 'sayInBackground',
      label: '后台回合也能发群',
      type: 'switch',
      hint: '默认关。打开后，定时任务、日记、子智能体这类没人在等的回合里也能用 qq_say_in_group 往白名单群说话；发送走 hub 通道并声明 proactive，chatlog 会留一条 bot 记录。',
    },
    {
      key: 'queueWhenBusy',
      label: '群里正热闹时先排队',
      type: 'switch',
      hint: '默认开。后台回合要发的那个群如果正有人说话还没接上、或者她刚在那儿说过话，就先排着不等插话，等群安静了再补发；主人在私聊里直接喊她发的那句不受影响，照旧立刻发。',
    },
    {
      key: 'queueTtlMinutes',
      label: '排队最多等多久（分钟）',
      type: 'number',
      min: 0,
      max: 240,
      step: 1,
      hint: '默认 10 分钟，对齐 dsh-plugin-autonomy 的待发队列。等到这个时间群还没安静，那条话就作废不发；填 0 等于关掉排队，忙也照发。',
    },
  ],
  setup(api) {
    const allowed = () => new Set((api.config()?.allow?.groups ?? []).map(String))
    const hint = () => {
      const g = [...allowed()]
      return g.length ? g.join('、') : '（还没配白名单群）'
    }

    api.rule(() => `你能主动翻别人的群：qq_peek_group(群号, 条数)。现在能翻的群号是 ${hint()}。别人提到某个群的事、你想知道那边在聊什么时就用它，不用等人转述。`)
    // 定时/后台回合（没人在等）里也能喊发群：开关打开时才把这条告诉她
    api.rule(() => api.settings?.().sayInBackground === true
      ? `定时任务、日记、子智能体这类后台回合里，你也可以主动去白名单群说话：qq_say_in_group(群, 内容)。那边没有人在等你，发完不必等回话，但要在最终输出里写清发到了哪个群、说了什么、message_id 是多少。`
      : '')
    // 群名 → 群号的对照（启动时取自网关，取不到就留空）
    let names = new Map()
    api.onebot('get_group_list', {}).then((list) => {
      for (const g of (list || [])) names.set(String(g.group_id), g.group_name ?? '')
    }).catch(() => {})
    const nameOf = (gid) => names.get(String(gid)) ?? ''
    const label = (gid) => nameOf(gid) ? `${nameOf(gid)}(${gid})` : String(gid)

    // ---- 忙时排队：后台回合发群，遇到那个群正热闹就先排着 ----
    const outboxFile = api.dataDir('outbox.json')
    let outbox = loadOutbox(outboxFile, api.log)
    // 她刚发完、网关还没回显的那一段靠自己记：判据以群历史为准，这里只补「最近一次出站」。
    const lastOut = new Map()
    api.on('activity', (e) => {
      const chatId = String(e?.chatId ?? '')
      if (!chatId.startsWith('group:') || e?.kind !== 'out') return
      lastOut.set(chatId.slice('group:'.length), Date.now())
    })

    const queueTtlMinutes = () => Math.max(0, Math.min(240, Number(api.settings?.().queueTtlMinutes ?? 10) || 0))

    /** 这个群现在是不是「正热闹」：有人说了话还没接上，或她刚在这儿说过话。 */
    const groupBusy = async (gid) => {
      const now = Date.now()
      let inAt = 0
      let histOut = 0
      // 判据以群历史为准：热重载、重启都不影响，也不用维护一份自己的影子状态。
      try {
        const r = await api.onebot('get_group_msg_history', { group_id: Number(gid), count: 20 })
        const self = String(api.config()?.botQQ ?? '')
        for (const m of (r?.messages || [])) {
          const at = m.time ? m.time * 1000 : 0
          if (!at) continue
          if (String(m.user_id ?? m.sender?.user_id) === self) histOut = Math.max(histOut, at)
          else inAt = Math.max(inAt, at)
        }
      } catch (e) {
        api.log.debug?.(`排队前查 ${gid} 的群历史失败，按不忙处理：${e?.message ?? e}`)
      }
      const outAt = Math.max(histOut, lastOut.get(gid) ?? 0)
      if (inAt > outAt && now - inAt <= WAITING_MS) return { busy: true, why: '那边有人说了话，还没接上' }
      if (outAt && now - outAt < COOLDOWN_MS) return { busy: true, why: '她刚在那个群说过话' }
      return { busy: false }
    }

    // <at:QQ号> / <reply:消息id> 还原成真段；写死的 ||| 当换行
    const parseSay = (body, quote) => {
      const segs = []
      const quoteId = String(quote ?? '').trim()
      if (quoteId) segs.push({ type: 'reply', data: { id: quoteId } })
      const re = /<at:\s*(\d+)\s*>|<reply:\s*(\d+)\s*>/g
      let last = 0
      let m
      while ((m = re.exec(body)) !== null) {
        const before = body.slice(last, m.index)
        if (before.trim()) segs.push({ type: 'text', data: { text: before.replace(/\|\|\|/g, '\n') } })
        if (m[1] !== undefined) segs.push({ type: 'at', data: { qq: m[1] } })
        else if (m[2] !== undefined && !segs.some((x) => x.type === 'reply')) segs.push({ type: 'reply', data: { id: m[2] } })
        last = re.lastIndex
      }
      const tail = body.slice(last)
      if (tail.trim() || segs.length === 0) segs.push({ type: 'text', data: { text: tail.replace(/\|\|\|/g, '\n') || body } })
      return segs
    }

    /** 直接发和排队补发共用一条路：发完自己记一笔「她刚说过话」。 */
    const sendSay = async (gid, body, quote) => {
      const segs = parseSay(body, quote)
      const needSegments = segs.some((x) => x.type !== 'text')
      const sentQuote = segs.find((x) => x.type === 'reply')?.data?.id ?? ''
      const hasAt = segs.some((x) => x.type === 'at')
      let r
      try {
        // 走 hub 的发送（不是 api.onebot 直发），并声明「这条是我说的话」：
        // hub 只有看到 proactive 才会在目标群的 chatlog 里补一条 bot 记录。
        r = needSegments
          ? await api.sendSegments(`group:${gid}`, segs, 'qq_say_in_group', SAY_LOGGED)
          : await api.sendText(`group:${gid}`, body.replace(/\|\|\|/g, '\n'), SAY_LOGGED)
      } catch (e) {
        if (!needSegments) return { ok: false, message: e?.message ?? String(e) }
        // 段被网关拒（引用 id 过期、at 不允许等）时退回纯文字，别整条发不出去
        api.log.warn(`带段发送失败，改发纯文字：${e?.message ?? e}`)
        try {
          r = await api.sendText(`group:${gid}`, body.replace(/<at:\s*\d+\s*>/g, '').replace(/<reply:\s*\d+\s*>/g, ''), SAY_LOGGED)
        } catch (e2) {
          return { ok: false, message: e2?.message ?? String(e2) }
        }
      }
      // 出站策略拦下时快捷发送返回 null——那不是发出去了
      if (r === null || r === undefined) return { ok: false, message: '被出站策略拦下了' }
      lastOut.set(gid, Date.now())
      return { ok: true, mid: String(r?.message_id ?? ''), sentQuote, hasAt }
    }

    const enqueueSay = (gid, body, quote, ttlMin) => {
      const now = Date.now()
      const item = {
        id: randomUUID().replace(/-/g, '').slice(0, 12),
        gid,
        body: String(body).slice(0, 2000),
        quote: String(quote ?? '').trim(),
        createdAt: now,
        expiresAt: now + ttlMin * 60_000,
        status: 'pending',
        attempts: 0,
      }
      outbox = trimOutbox([...outbox, item])
      saveOutbox(outboxFile, outbox, api.log)
      return item
    }

    /** 定时扫描：群安静了就补发，等到过期就作废。与 autonomy 的 outbox 同口径。 */
    let draining = false
    const drainOutbox = async () => {
      if (draining || !outbox.some((x) => x.status === 'pending')) return
      draining = true
      try {
        for (const item of outbox) {
          if (item.status !== 'pending') continue
          if (Date.now() >= item.expiresAt) {
            item.status = 'expired'
            item.note = '等到过期，那个群也没安静下来'
            saveOutbox(outboxFile, outbox, api.log)
            api.log.info(`排队的话过期作废（群 ${item.gid}）：${item.body.slice(0, 40)}`)
            continue
          }
          const b = await groupBusy(item.gid)
          if (b.busy) continue
          item.status = 'sending'
          saveOutbox(outboxFile, outbox, api.log)
          const sent = await sendSay(item.gid, item.body, item.quote)
          if (sent.ok) {
            item.status = 'sent'
            item.note = '群安静后补发'
            api.log.info(`排队的话已补发到 ${label(item.gid)}${sent.sentQuote ? '（引用 ' + sent.sentQuote + '）' : ''}：${item.body.slice(0, 40)}`)
          } else {
            item.attempts = (item.attempts ?? 0) + 1
            if (item.attempts >= OUTBOX_ATTEMPTS) {
              item.status = 'failed'
              item.note = `补发 ${item.attempts} 次都没成功：${sent.message ?? ''}`
              api.log.warn(`排队的话补发失败，已放弃（群 ${item.gid}）：${sent.message ?? ''}`)
            } else {
              item.status = 'pending'
              item.note = `第 ${item.attempts} 次补发失败，下次再试`
            }
          }
          saveOutbox(outboxFile, outbox, api.log)
        }
        const before = outbox.length
        outbox = trimOutbox(outbox)
        if (outbox.length !== before) saveOutbox(outboxFile, outbox, api.log)
      } finally {
        draining = false
      }
    }
    api.every(20_000, drainOutbox, '发群排队补发')

    api.rule(() => {
      const idx = [...allowed()].map((g) => label(g)).join('、')
      const ttl = queueTtlMinutes()
      const queueNote = api.settings?.().queueWhenBusy !== false && ttl > 0
        ? `另外：后台回合（定时任务、日记、子智能体这类没人在等的回合）发群时，如果那个群正有人说话还没接上、或者你刚在那儿说过话，模块会先替你排上队，等群安静了自动补发，最多等 ${ttl} 分钟，过期作废——工具结果会告诉你排没排上，别当成已经发出去了。`
        : ''
      return `主人能在私聊里喊你去某个群说话：qq_say_in_group(群, 内容)。可发的群：${idx}（群名取自网关的群列表，写群名或群号都行）。主人让你去某个群说句话时，就用它把话原样发过去，然后回主人一句发了。内容里可以写 <at:QQ号> 真 @ 人、写 <reply:消息id> 引用某条，这两个标签会被还原成真动作（不会显示成字符）。主人说「引着某条说」「接着那条说」时，把那条的 message_id 填进 qq_say_in_group 的引用参数（不知道 id 就先 qq_peek_group 看一眼，每行开头 [] 里就是）。判断引用有没有真挂上：你自己翻聊天记录只会看到纯文字（你那边没有段层），要确认就用 qq_msg_info(消息id) 查一下——它会告诉你这条消息带没带 reply 段，发完带引用的消息先自查一遍再回话。${queueNote}`
    })

    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      return api.defineTool({
        name: 'qq_peek_group',
        description: '翻一个白名单群里最近的聊天记录（只读）。想知道那个群最近在聊什么、别人提到那边的事时用。图片会另给可以直接取的新链接。',
        properties: {
          group_id: { type: 'string', description: '要翻的群号' },
          count: { type: 'integer', description: '翻多少条，默认 30，最多 1000（条数越多越吃上下文）' },
          images: { type: 'integer', description: '顺带给几条图片链接，默认 40，最多 200' },
        },
        required: ['group_id'],
        execute: async ({ group_id, count, images }) => {
          const gid = String(group_id ?? '').trim()
          if (!/^\d+$/.test(gid)) return { ok: false, message: '群号要写纯数字' }
          if (!allowed().has(gid)) return { ok: false, message: `群 ${gid} 不在白名单里，能翻的只有：${hint()}` }
          const n = Math.max(1, Math.min(1000, Number(count) || 30))
          const picCap = Math.max(0, Math.min(200, images === undefined || images === null ? 40 : Number(images) || 0))
          let r
          try {
            r = await api.onebot('get_group_msg_history', { group_id: Number(gid), count: n })
          } catch (e) {
            return { ok: false, message: '翻记录失败：' + (e?.message ?? String(e)) }
          }
          const msgs = (r?.messages || []).slice(-n)
          if (!msgs.length) return { ok: true, message: '那个群没翻到聊天记录' }
          const self = String(api.config()?.botQQ ?? '')
          const pics = []
          const lines = msgs.map((m) => {
            const segs = Array.isArray(m.message) ? m.message : []
            const body = segs.map((s) => {
              const url = s?.type === 'image' ? imageUrlOf(s) : ''
              if (url && pics.length < picCap) {
                pics.push({ url, kind: urlKind(url) })
                return `[图片#${pics.length}]`
              }
              return segText(s, self)
            }).join('').trim() || (m.raw_message ?? '')
            const who = String(m.user_id ?? m.sender?.user_id) === self
              ? '你'
              : (m.sender?.card || m.sender?.nickname || String(m.user_id ?? ''))
            const t = m.time ? new Date(m.time * 1000).toTimeString().slice(0, 5) : ''
            const mid = m.message_id ?? m.real_id ?? ''
            return `[${mid}] ${t} ${who}：${body.slice(0, 150)}`
          })
          let tail = ''
          if (pics.length) {
            const keys = new Map()
            for (const kind of new Set(pics.map((p) => p.kind))) keys.set(kind, await rkeyOf(api, kind))
            tail = `\n\n图片链接（${pics.length} 张，rkey 已按网关当前值续上，可直接取）:\n` +
              pics.map((p, i) => `[图片#${i + 1}] ${withRkey(p.url, keys.get(p.kind))}`).join('\n')
          }
          api.log.debug(`qq_peek_group ${gid} 取到 ${msgs.length} 条，图片 ${pics.length} 张`)
          return { ok: true, message: lines.join('\n') + tail }
        },
      })
    })

    // 主人私聊里、或（开关打开时）定时/后台回合：喊她去指定群说一句话（原样发出）
    api.tool(({ chat, level }) => {
      const fromBackground = chat.kind === 'system' && api.settings?.().sayInBackground === true
      if (!fromBackground && (chat.kind !== 'private' || level !== 'full')) return []
      return api.defineTool({
        name: 'qq_say_in_group',
        description: '主人让你去某个群里说一句话时用。只能发到白名单群；群名或群号都行。',
        properties: {
          group: { type: 'string', description: '群名（取自网关的群列表）或群号' },
          text: { type: 'string', description: '要说的话，原样发出' },
          quote: { type: 'string', description: '可选：要引用回复的那条群消息 id（qq_peek_group 每行开头 [] 里的数字）。也可以直接写在内容里：<reply:消息id>；想 @ 谁就在内容里写 <at:QQ号>' },
        },
        required: ['group', 'text'],
        execute: async ({ group, text, quote }) => {
          const want = String(group ?? '').trim()
          const body = String(text ?? '').trim()
          if (!body) return { ok: false, message: '要说的内容是空的' }
          let gid = ''
          if (/^\d+$/.test(want) && allowed().has(want)) gid = want
          if (!gid) {
            for (const g of allowed()) {
              const nm = nameOf(g)
              if (nm && (nm.includes(want) || want.includes(nm))) { gid = g; break }
            }
          }
          if (!gid) {
            const idx = [...allowed()].map((g) => label(g)).join('、')
            return { ok: false, message: `没认出是哪个群（能发的：${idx}）` }
          }
          // 后台回合：那个群正热闹就先排着，别插话。主人在私聊里直接喊她发的那句不排队（他正等着结果）。
          if (chat.kind === 'system' && api.settings?.().queueWhenBusy !== false) {
            const ttlMin = queueTtlMinutes()
            if (ttlMin > 0) {
              const b = await groupBusy(gid)
              if (b.busy) {
                enqueueSay(gid, body, quote, ttlMin)
                api.log.info(`qq_say_in_group 排队：${label(gid)} 正忙（${b.why}），最多等 ${ttlMin} 分钟`)
                return { ok: true, message: `那个群现在正热闹（${b.why}），已经排上队，安静下来会自动发，最多等 ${ttlMin} 分钟；过期就不发了。` }
              }
            }
          }
          const sent = await sendSay(gid, body, quote)
          if (!sent.ok) return { ok: false, message: '发失败：' + (sent.message ?? '') }
          api.log.info(`qq_say_in_group 已发到 ${label(gid)}${sent.sentQuote ? '（引用 ' + sent.sentQuote + '）' : ''}${sent.hasAt ? '（带 @）' : ''}：${body.slice(0, 40)}`)
          return { ok: true, message: `已发到 ${label(gid)}` }
        },
      })
    })

    // 只读：查一条消息实际带了哪些段（用来确认引用 / @ 到底挂上没）
    api.tool(() => [
      api.defineTool({
        name: 'qq_msg_info',
        description: '查一条 QQ 消息实际带哪些段：有没有引用段（type=reply）、有没有 @ 段。发完带引用的消息可以拿它自查，不用等人肉眼看群。',
        properties: {
          message_id: { type: 'string', description: '要查的消息 id（qq_peek_group 每行开头 [] 里的数字，或 qq_say_in_group 返回里的）' },
        },
        required: ['message_id'],
        execute: async ({ message_id }) => {
          const mid = String(message_id ?? '').trim()
          if (!/^\d+$/.test(mid)) return { ok: false, message: '消息 id 得是纯数字' }
          let r = null
          try {
            r = await api.onebot('get_msg', { message_id: mid })
          } catch (e) {
            return { ok: false, message: '查不到：' + (e?.message ?? String(e)) }
          }
          const segs = Array.isArray(r?.message) ? r.message : []
          if (!segs.length) return { ok: true, message: `消息 ${mid} 没取到段（可能已撤回或不存在）` }
          const kinds = segs.map((x) => {
            if (x.type === 'reply') return `reply(id=${x.data?.id})`
            if (x.type === 'at') return `at(qq=${x.data?.qq})`
            if (x.type === 'text') return `text("${String(x.data?.text ?? '').slice(0, 30)}")`
            if (x.type === 'image') return 'image'
            if (x.type === 'face' || x.type === 'mface') return 'sticker'
            return x.type
          })
          const hasReply = segs.some((x) => x.type === 'reply')
          const hasAt = segs.some((x) => x.type === 'at')
          const head = `消息 ${mid}：${kinds.join(' + ')}`
          const verdict = hasReply
            ? `\n首段是 reply → 引用确实挂上了（引的是 ${segs.find((x) => x.type === 'reply')?.data?.id}）`
            : '\n没有 reply 段 → 这条没带引用'
          const imgUrls = segs.filter((x) => x.type === 'image').map(imageUrlOf).filter(Boolean)
          let links = ''
          if (imgUrls.length) {
            const keys = new Map()
            for (const kind of new Set(imgUrls.map(urlKind))) keys.set(kind, await rkeyOf(api, kind))
            links = `\n\n图片链接（rkey 已续上，可直接取）:\n` +
              imgUrls.map((u, i) => `[图${i + 1}] ${withRkey(u, keys.get(urlKind(u)))}`).join('\n')
          }
          return { ok: true, message: head + verdict + (hasAt ? '\n带 at 段 → 真的 @ 到人了' : '') + links }
        },
      }),
    ])
  },
}
