/** @type {import('../aurabot').AurabotModule} */
// 让她能主动翻「别的群」的聊天记录（内置 qq_chat_history 只能翻当前聊天）
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

function imageUrlOf(seg) {
  const d = seg?.data ?? {}
  const u = d.url || d.file_url
  return typeof u === 'string' && /^https?:\/\//.test(u) ? u : ''
}

export default {
  id: 'qq-peek',
  name: '跨群看一眼·喊她说话',
  version: '0.1.0',
  api: 1,
  description: '翻白名单群的聊天记录（只读）；主人私聊里还能喊她去指定群说一句话',
  setup(api) {
    const allowed = () => new Set((api.config()?.allow?.groups ?? []).map(String))
    const hint = () => {
      const g = [...allowed()]
      return g.length ? g.join('、') : '（还没配白名单群）'
    }

    api.rule(() => `你能主动翻别人的群：qq_peek_group(群号, 条数)。现在能翻的群号是 ${hint()}。别人提到某个群的事、你想知道那边在聊什么时就用它，不用等人转述。`)
    // 群名 → 群号的对照（启动时取自网关，取不到就留空）
    let names = new Map()
    api.onebot('get_group_list', {}).then((list) => {
      for (const g of (list || [])) names.set(String(g.group_id), g.group_name ?? '')
    }).catch(() => {})
    const nameOf = (gid) => names.get(String(gid)) ?? ''
    const label = (gid) => nameOf(gid) ? `${nameOf(gid)}(${gid})` : String(gid)
    api.rule(() => {
      const idx = [...allowed()].map((g) => label(g)).join('、')
      return `主人能在私聊里喊你去某个群说话：qq_say_in_group(群, 内容)。可发的群：${idx}（群名取自网关的群列表，写群名或群号都行）。主人让你去某个群说句话时，就用它把话原样发过去，然后回主人一句发了。内容里可以写 <at:QQ号> 真 @ 人、写 <reply:消息id> 引用某条，这两个标签会被还原成真动作（不会显示成字符）。主人说「引着某条说」「接着那条说」时，把那条的 message_id 填进 qq_say_in_group 的引用参数（不知道 id 就先 qq_peek_group 看一眼，每行开头 [] 里就是）。判断引用有没有真挂上：你自己翻聊天记录只会看到纯文字（你那边没有段层），要确认就用 qq_msg_info(消息id) 查一下——它会告诉你这条消息带没带 reply 段，发完带引用的消息先自查一遍再回话。`
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

    // 主人私聊里：喊她去指定群说一句话（原样发出）
    api.tool(({ chat, level }) => {
      if (chat.kind !== 'private' || level !== 'full') return []
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
          const quoteId = String(quote ?? '').trim()
          // 把 <at:QQ号> / <reply:消息id> 还原成真正的段；||| 按换行处理（这里原样发，不拆多条）
          const segs = []
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
          const needSegments = segs.some((x) => x.type !== 'text')
          const sentQuote = segs.find((x) => x.type === 'reply')?.data?.id ?? ''
          try {
            if (needSegments) {
              await api.onebot('send_group_msg', { group_id: Number(gid), message: segs })
            } else {
              // 纯文字分支：把 ||| 换成换行，别让分隔符露到群里
              await api.sendText(`group:${gid}`, body.replace(/\|\|\|/g, '\n'))
            }
          } catch (e) {
            if (!needSegments) return { ok: false, message: '发失败：' + (e?.message ?? String(e)) }
            // 段被网关拒（引用 id 过期、at 不允许等）时退回纯文字，别整条发不出去
            api.log.warn(`带段发送失败，改发纯文字：${e?.message ?? e}`)
            try {
              await api.sendText(`group:${gid}`, body.replace(/<at:\s*\d+\s*>/g, '').replace(/<reply:\s*\d+\s*>/g, ''))
            } catch (e2) {
              return { ok: false, message: '发失败：' + (e2?.message ?? String(e2)) }
            }
          }
          api.log.info(`qq_say_in_group 已发到 ${label(gid)}${sentQuote ? '（引用 ' + sentQuote + '）' : ''}${segs.some((x) => x.type === 'at') ? '（带 @）' : ''}：${body.slice(0, 40)}`)
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
