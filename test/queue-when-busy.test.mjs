// 回归测试：后台回合发群的「忙时排队」（0.4.0）
//
// 口径照 dsh-plugin-autonomy 的 outbox：那个群有人在等她接话、或她刚在同一个群说过话，
// 都算「正热闹」——后台回合没人在等，先排着，群安静了再补发；等到时限还不安静就作废。
// 主人在私聊里直接喊她发的那句不排队（他正等着结果）。这里把这些行为钉死。
//
// 跑法：node --test test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import mod from '../index.mjs'
import {
  boot, sayToolFor, drain, readOutbox, makeApi, tempDir,
  SYSTEM_CHAT, PRIVATE_CHAT, GROUP_ID, SELF, ago,
} from './helpers.mjs'

/** 别人 1 分钟前说了话，她还没接——她在那个群「有事没干完」 */
const WAITING = [{ user_id: '111', time: ago(1) }]
/** 她 1 分钟前刚在那个群说过话——还在冷却里 */
const SPOKE_RECENTLY = [{ user_id: SELF, time: ago(1) }]
/** 她 5 分钟前说过话，冷却已过——可以发 */
const QUIET = [{ user_id: SELF, time: ago(5) }]
/** 15 分钟前的旧消息——早就不该等着她接了，不算堵 */
const STALE = [{ user_id: '111', time: ago(15) }]

const sayTool = (ctx) => sayToolFor(ctx.toolFns, SYSTEM_CHAT)

test('后台回合：群里有人等着接话 → 不插话，排队', async () => {
  const ctx = await boot({ sayInBackground: true, history: { [GROUP_ID]: WAITING } })
  const res = await sayTool(ctx).execute({ group: GROUP_ID, text: '我来插一句' })
  assert.equal(res.ok, true)
  assert.match(res.message, /排上队/)
  assert.equal(ctx.calls.sendText.length, 0, '不能直接发出去')
  assert.equal(ctx.calls.sendSegments.length, 0)

  const queued = readOutbox(ctx.dataDir)
  assert.equal(queued.length, 1)
  assert.equal(queued[0].status, 'pending')
  assert.equal(queued[0].gid, GROUP_ID)
  assert.equal(queued[0].body, '我来插一句')
})

test('后台回合：她刚在这个群说过话 → 也排队，别连发', async () => {
  const ctx = await boot({ sayInBackground: true, history: { [GROUP_ID]: SPOKE_RECENTLY } })
  const res = await sayTool(ctx).execute({ group: GROUP_ID, text: '再说一句' })
  assert.equal(res.ok, true)
  assert.equal(ctx.calls.sendText.length, 0)
  assert.equal(readOutbox(ctx.dataDir).length, 1)
})

test('后台回合：群已安静 → 照常直接发', async () => {
  const ctx = await boot({ sayInBackground: true, history: { [GROUP_ID]: QUIET } })
  const res = await sayTool(ctx).execute({ group: GROUP_ID, text: '现在可以说了' })
  assert.equal(res.ok, true)
  assert.equal(ctx.calls.sendText.length, 1)
  assert.equal(readOutbox(ctx.dataDir).length, 0, '直接发的不进队列')
})

test('后台回合：十几分钟前的旧消息不算「有人等她」→ 直接发', async () => {
  const ctx = await boot({ sayInBackground: true, history: { [GROUP_ID]: STALE } })
  const res = await sayTool(ctx).execute({ group: GROUP_ID, text: '陈年旧事就别排队了' })
  assert.equal(res.ok, true)
  assert.equal(ctx.calls.sendText.length, 1)
})

test('主人私聊：群里正热闹也直接发，不排队（他正等着结果）', async () => {
  const ctx = await boot({ sayInBackground: true, history: { [GROUP_ID]: WAITING } })
  const tool = sayToolFor(ctx.toolFns, PRIVATE_CHAT, 'full')
  const res = await tool.execute({ group: GROUP_ID, text: '主人让我说的' })
  assert.equal(res.ok, true)
  assert.equal(ctx.calls.sendText.length, 1)
  assert.equal(readOutbox(ctx.dataDir).length, 0)
})

test('关掉「群里正热闹时先排队」→ 忙也照发', async () => {
  const ctx = await boot({ sayInBackground: true, queueWhenBusy: false, history: { [GROUP_ID]: WAITING } })
  await sayTool(ctx).execute({ group: GROUP_ID, text: '不等了' })
  assert.equal(ctx.calls.sendText.length, 1)
  assert.equal(readOutbox(ctx.dataDir).length, 0)
})

test('排队时限填 0 → 等于不排队，忙也照发', async () => {
  const ctx = await boot({ sayInBackground: true, queueTtlMinutes: 0, history: { [GROUP_ID]: WAITING } })
  await sayTool(ctx).execute({ group: GROUP_ID, text: '不等了' })
  assert.equal(ctx.calls.sendText.length, 1)
  assert.equal(readOutbox(ctx.dataDir).length, 0)
})

test('排到队后群安静了：定时扫描补发，仍然带 proactive 留痕标记', async () => {
  const ctx = await boot({ sayInBackground: true, history: { [GROUP_ID]: WAITING } })
  await sayTool(ctx).execute({ group: GROUP_ID, text: '等安静了再说' })
  // 群里安静下来：她 5 分钟前说过话，冷却已过
  ctx.history[GROUP_ID] = QUIET
  await drain(ctx)

  assert.equal(ctx.calls.sendText.length, 1)
  assert.equal(ctx.calls.sendText[0].target, `group:${GROUP_ID}`)
  assert.equal(ctx.calls.sendText[0].text, '等安静了再说')
  // 补发也必须留痕，否则 chatlog 里还是查不到（0.3.0 丢档的老问题）
  assert.deepEqual(ctx.calls.sendText[0].opts, { proactive: true, proactiveCause: 'qq_say_in_group' })
  assert.equal(readOutbox(ctx.dataDir)[0].status, 'sent')
})

test('排队的话里带 <at:QQ号>：补发时还原成 at 段', async () => {
  const ctx = await boot({ sayInBackground: true, history: { [GROUP_ID]: WAITING } })
  await sayTool(ctx).execute({ group: GROUP_ID, text: '叫一下 <at:1250226509>' })
  ctx.history[GROUP_ID] = QUIET
  await drain(ctx)

  assert.equal(ctx.calls.sendSegments.length, 1)
  assert.deepEqual(ctx.calls.sendSegments[0].segs.at(-1), { type: 'at', data: { qq: '1250226509' } })
  assert.deepEqual(ctx.calls.sendSegments[0].opts, { proactive: true, proactiveCause: 'qq_say_in_group' })
})

test('等不到群安静：超过时限作废，绝不硬发（重启后读到也照此办）', async () => {
  const ctx = await boot({ sayInBackground: true, history: { [GROUP_ID]: WAITING } })
  await sayTool(ctx).execute({ group: GROUP_ID, text: '过期就别发了' })

  // 把到期时间改到过去，再按重启的方式读一遍队列
  const file = join(ctx.dataDir, 'outbox.json')
  const items = JSON.parse(readFileSync(file, 'utf8'))
  items[0].expiresAt = Date.now() - 1000
  writeFileSync(file, JSON.stringify(items))

  const again = makeApi({ sayInBackground: true, history: { [GROUP_ID]: WAITING }, dataDir: ctx.dataDir })
  mod.setup(again.api)
  await new Promise((r) => setTimeout(r, 0))
  await drain({ timers: again.timers })

  assert.equal(again.calls.sendText.length, 0)
  assert.equal(again.calls.sendSegments.length, 0)
  assert.equal(readOutbox(ctx.dataDir)[0].status, 'expired')
})

test('补发连续失败 3 次：标 failed，不再无限重试', async () => {
  const ctx = await boot({ sayInBackground: true, history: { [GROUP_ID]: WAITING } })
  await sayTool(ctx).execute({ group: GROUP_ID, text: '发不出去的话' })
  ctx.history[GROUP_ID] = QUIET
  ctx.api.sendText = async () => { throw new Error('网关抽风') }

  await drain(ctx)
  await drain(ctx)
  assert.equal(readOutbox(ctx.dataDir)[0].status, 'pending', '前两次失败还留着再试')
  await drain(ctx)

  const queued = readOutbox(ctx.dataDir)
  assert.equal(queued[0].status, 'failed')
  assert.match(queued[0].note, /3 次/)
})

test('补发中途进程挂了：sending 状态重读时退回待发，不会永远卡住', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'outbox.json'), JSON.stringify([{
    id: 'x1', gid: GROUP_ID, body: '半路的话', quote: '',
    createdAt: Date.now() - 1000, expiresAt: Date.now() + 600_000,
    status: 'sending', attempts: 0,
  }]))

  const ctx = await boot({ sayInBackground: true, dataDir: dir, history: { [GROUP_ID]: QUIET } })
  await drain(ctx)

  assert.equal(ctx.calls.sendText.length, 1)
  assert.equal(readOutbox(dir)[0].status, 'sent')
})

test('规则里会告诉她「后台回合遇忙先排队」，关掉排队时就不提', async () => {
  const on = await boot({ sayInBackground: true })
  assert.match(on.ruleFns.map((f) => f()).join('\n'), /先替你排上队/)

  const off = await boot({ sayInBackground: true, queueWhenBusy: false })
  assert.doesNotMatch(off.ruleFns.map((f) => f()).join('\n'), /排上队/)
})
