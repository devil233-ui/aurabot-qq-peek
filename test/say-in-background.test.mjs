// 回归测试：后台/定时回合能不能用 qq_say_in_group（0.3.0 的 sayInBackground 开关）
//
// 起因：2026-11-22 定时任务用 HTTP 直发 3004，绕过插件 → chatlog 里查不到自己说过什么（丢档）。
// 0.3.0 让后台回合也走插件通道发群，插件顺手留档。这里把「什么回合拿得到这个工具」钉死，
// 免得哪天条件一改又悄悄退化回「后台发不了/发了不落档」。
//
// 跑法：node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'

import mod from '../index.mjs'

/** 造一个够用的 api；把 rule/tool 的工厂函数留下来，供断言时按不同 chat 调 */
function makeApi ({ sayInBackground = false, groups = ['1034185861'], groupNames = { 1034185861: '剧透群' } } = {}) {
  const calls = { onebot: [], sendText: [], sendSegments: [], log: [] }
  const ruleFns = []
  const toolFns = []
  const api = {
    config: () => ({ allow: { groups } }),
    settings: () => ({ sayInBackground }),
    rule: (fn) => { ruleFns.push(fn) },
    tool: (fn) => { toolFns.push(fn) },
    defineTool: (def) => def,
    onebot: async (action, params) => {
      calls.onebot.push({ action, params })
      if (action === 'get_group_list') return Object.entries(groupNames).map(([id, name]) => ({ group_id: id, group_name: name }))
      return { message_id: 123 }
    },
    sendText: async (target, text, opts) => { calls.sendText.push({ target, text, opts }); return { message_id: 456 } },
    sendSegments: async (target, segs, note, opts) => { calls.sendSegments.push({ target, segs, note, opts }); return { message_id: 789 } },
    log: { info: (...a) => calls.log.push(['info', ...a]), warn: (...a) => calls.log.push(['warn', ...a]), error: (...a) => calls.log.push(['error', ...a]) },
  }
  return { api, calls, ruleFns, toolFns }
}

/** 把 api.tool 回调的返回值统一成数组（模块里有的返回单个 defineTool，有的返回数组） */
function asList (out) {
  if (!out) return []
  return Array.isArray(out) ? out : [out]
}

/** 取某个回合下模块暴露的全部工具名 */
function toolNamesFor (mod_, toolFns, chat, level = 'full') {
  const names = []
  for (const fn of toolFns) {
    for (const d of asList(fn({ chat, level, defineTool: (x) => x }))) if (d?.name) names.push(d.name)
  }
  return names
}

/** 同上，但把 qq_say_in_group 这个工具定义取出来 */
function sayToolFor (toolFns, chat, level = 'full') {
  for (const fn of toolFns) {
    for (const d of asList(fn({ chat, level, defineTool: (x) => x }))) if (d?.name === 'qq_say_in_group') return d
  }
  return null
}

async function boot (opts) {
  const ctx = makeApi(opts)
  mod.setup(ctx.api)
  // setup 里有一次 get_group_list 的异步补群名，等它落地
  await new Promise((r) => setTimeout(r, 0))
  return ctx
}

const SYSTEM_CHAT = { kind: 'system', id: 'sys-1' }
const PRIVATE_CHAT = { kind: 'private', id: 'private:1250226509' }
const GROUP_CHAT = { kind: 'group', id: 'group:1034185861' }

test('后台回合：开关关着就看不到 qq_say_in_group', async () => {
  const { toolFns } = await boot({ sayInBackground: false })
  assert.deepEqual(toolNamesFor(mod, toolFns, SYSTEM_CHAT).filter((n) => n === 'qq_say_in_group'), [])
})

test('后台回合：开关打开就拿到 qq_say_in_group', async () => {
  const { toolFns } = await boot({ sayInBackground: true })
  assert.ok(toolNamesFor(mod, toolFns, SYSTEM_CHAT).includes('qq_say_in_group'))
})

test('主人私聊 full 档：开关关着也有 qq_say_in_group', async () => {
  const { toolFns } = await boot({ sayInBackground: false })
  assert.ok(toolNamesFor(mod, toolFns, PRIVATE_CHAT, 'full').includes('qq_say_in_group'))
})

test('主人私聊非 full 档：不给（避免低权限回合乱发）', async () => {
  const { toolFns } = await boot({ sayInBackground: true })
  assert.ok(!toolNamesFor(mod, toolFns, PRIVATE_CHAT, 'social').includes('qq_say_in_group'))
})

test('群回合：不给 qq_say_in_group（只有主人私聊/后台能给）', async () => {
  const { toolFns } = await boot({ sayInBackground: true })
  assert.ok(!toolNamesFor(mod, toolFns, GROUP_CHAT, 'full').includes('qq_say_in_group'))
})

test('纯文字：走 api.sendText 并带 proactive 留痕标记，||| 换成换行', async () => {
  const { toolFns, calls } = await boot({ sayInBackground: true })
  const tool = sayToolFor(toolFns, SYSTEM_CHAT)
  const res = await tool.execute({ group: '1034185861', text: '第一行|||第二行' })
  assert.equal(res.ok, true)
  assert.equal(calls.sendText.length, 1)
  assert.equal(calls.sendText[0].target, 'group:1034185861')
  assert.equal(calls.sendText[0].text, '第一行\n第二行')
  // 不带这个标记，hub 就不会在目标群 chatlog 里补 bot 记录（0.3.0 的丢档根因）
  assert.deepEqual(calls.sendText[0].opts, { proactive: true, proactiveCause: 'qq_say_in_group' })
  assert.equal(calls.onebot.filter((c) => c.action === 'send_group_msg').length, 0)
})

test('带 @ 时走 hub 的 sendSegments（不是 onebot 直发），at 段被还原且带留痕标记', async () => {
  const { toolFns, calls } = await boot({ sayInBackground: true })
  const tool = sayToolFor(toolFns, SYSTEM_CHAT)
  const res = await tool.execute({ group: '剧透群', text: '看这个 <at:1250226509>' })
  assert.equal(res.ok, true)
  assert.equal(calls.sendSegments.length, 1)
  assert.equal(calls.sendSegments[0].target, 'group:1034185861')
  assert.deepEqual(calls.sendSegments[0].segs, [
    { type: 'text', data: { text: '看这个 ' } },
    { type: 'at', data: { qq: '1250226509' } },
  ])
  assert.deepEqual(calls.sendSegments[0].opts, { proactive: true, proactiveCause: 'qq_say_in_group' })
  assert.equal(calls.onebot.filter((c) => c.action === 'send_group_msg').length, 0, '不能再用 onebot 直发绕开留痕')
})

test('引用：reply 段在最前面，且只挂一次', async () => {
  const { toolFns, calls } = await boot({ sayInBackground: true })
  const tool = sayToolFor(toolFns, SYSTEM_CHAT)
  await tool.execute({ group: '1034185861', text: '回一下', quote: '999888' })
  const sent = calls.sendSegments[0]
  assert.deepEqual(sent.segs[0], { type: 'reply', data: { id: '999888' } })
})

test('白名单外的群：直接拒绝，一个请求都不发', async () => {
  const { toolFns, calls } = await boot({ sayInBackground: true, groups: ['1034185861'] })
  const tool = sayToolFor(toolFns, SYSTEM_CHAT)
  const res = await tool.execute({ group: '999999999', text: '喂' })
  assert.equal(res.ok, false)
  assert.match(res.message, /没认出是哪个群/)
  assert.equal(calls.sendText.length, 0)
  assert.equal(calls.sendSegments.length, 0)
})

test('空内容：拒绝发送', async () => {
  const { toolFns, calls } = await boot({ sayInBackground: true })
  const tool = sayToolFor(toolFns, SYSTEM_CHAT)
  const res = await tool.execute({ group: '1034185861', text: '   ' })
  assert.equal(res.ok, false)
  assert.equal(calls.sendText.length, 0)
  assert.equal(calls.sendSegments.length, 0)
})

test('带段发送被网关拒：退回纯文字，且剥掉 <at:> 标记', async () => {
  const ctx = makeApi({ sayInBackground: true })
  // 带段那条走 hub 的 sendSegments；这里让它抛，验证退回纯文字的兜底
  ctx.api.sendSegments = async () => { throw new Error('引用 id 过期') }
  mod.setup(ctx.api)
  await new Promise((r) => setTimeout(r, 0))
  const tool = sayToolFor(ctx.toolFns, SYSTEM_CHAT)
  const res = await tool.execute({ group: '1034185861', text: '喊 <at:1250226509>' })
  assert.equal(res.ok, true, '退回纯文字后算发送成功')
  assert.equal(ctx.calls.sendText.length, 1)
  assert.ok(!ctx.calls.sendText[0].text.includes('<at:'))
  assert.ok(ctx.calls.log.some(([lvl, msg]) => lvl === 'warn' && String(msg).includes('改发纯文字')))
})

test('不许自己直连 HTTP 发群：源码里不能出现 3004 端口', async () => {
  // 丢档的根因就是「绕过插件直发」。这条守住防线：要发群只能走 api.sendText / api.sendSegments（都带留痕标记）。
  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.ok(!/127\.0\.0\.1:3004|localhost:3004/.test(src), '源码里出现 3004 直连，绕过了插件的留档')
  assert.ok(!/send_group_msg['"]\s*,\s*\{[^}]*\}\s*\)\s*;?\s*\/\/\s*http/i.test(src))
})

test('段发送被拒时退回纯文字，退回去的那条也带留痕标记', async () => {
  const { api, toolFns, calls } = await boot({ sayInBackground: true })
  api.sendSegments = async (target, segs, note, opts) => { calls.sendSegments.push({ target, segs, note, opts }); throw new Error('引用 id 过期') }
  const tool = sayToolFor(toolFns, SYSTEM_CHAT)
  const res = await tool.execute({ group: '1034185861', text: '带引用 <reply:999> 的话' })
  assert.equal(res.ok, true)
  assert.equal(calls.sendText.length, 1)
  assert.deepEqual(calls.sendText[0].opts, { proactive: true, proactiveCause: 'qq_say_in_group' })
})
