// 测试共用的：造 api、boot、按回合挑工具、读排队文件
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import mod from '../index.mjs'

/** 每个 boot 一个自己的数据目录（排队文件落在这里），进程退出时统一删 */
const dirs = []
export function tempDir () {
  const d = mkdtempSync(join(tmpdir(), 'qq-peek-test-'))
  dirs.push(d)
  return d
}
process.on('exit', () => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** 造一个够用的 api；把 rule/tool 的工厂函数留下来，供断言时按不同 chat 调 */
export function makeApi ({
  sayInBackground = false,
  queueWhenBusy,
  queueTtlMinutes,
  groups = ['1034185861'],
  groupNames = { 1034185861: '剧透群' },
  history = {},
  dataDir: fixedDir,
} = {}) {
  const calls = { onebot: [], sendText: [], sendSegments: [], log: [] }
  const ruleFns = []
  const toolFns = []
  const listeners = []
  const timers = []
  const dataDir = fixedDir ?? tempDir()
  const api = {
    config: () => ({ allow: { groups }, botQQ: '1250226509' }),
    settings: () => {
      const s = { sayInBackground }
      if (queueWhenBusy !== undefined) s.queueWhenBusy = queueWhenBusy
      if (queueTtlMinutes !== undefined) s.queueTtlMinutes = queueTtlMinutes
      return s
    },
    rule: (fn) => { ruleFns.push(fn) },
    tool: (fn) => { toolFns.push(fn) },
    defineTool: (def) => def,
    dataDir: (...parts) => join(dataDir, ...parts),
    on: (event, fn) => { listeners.push({ event, fn }); return () => {} },
    every: (ms, fn, label) => { timers.push({ ms, fn, label }); return () => {} },
    onebot: async (action, params) => {
      calls.onebot.push({ action, params })
      if (action === 'get_group_list') return Object.entries(groupNames).map(([id, name]) => ({ group_id: id, group_name: name }))
      if (action === 'get_group_msg_history') return { messages: history[params?.group_id] ?? [] }
      return { message_id: 123 }
    },
    sendText: async (target, text, opts) => { calls.sendText.push({ target, text, opts }); return { message_id: 456 } },
    sendSegments: async (target, segs, note, opts) => { calls.sendSegments.push({ target, segs, note, opts }); return { message_id: 789 } },
    log: {
      info: (...a) => calls.log.push(['info', ...a]),
      warn: (...a) => calls.log.push(['warn', ...a]),
      error: (...a) => calls.log.push(['error', ...a]),
      debug: (...a) => calls.log.push(['debug', ...a]),
    },
  }
  return { api, calls, ruleFns, toolFns, listeners, timers, dataDir, history }
}

/** 把 api.tool 回调的返回值统一成数组（模块里有的返回单个 defineTool，有的返回数组） */
export function asList (out) {
  if (!out) return []
  return Array.isArray(out) ? out : [out]
}

/** 取某个回合下模块暴露的全部工具名 */
export function toolNamesFor (toolFns, chat, level = 'full') {
  const names = []
  for (const fn of toolFns) {
    for (const d of asList(fn({ chat, level, defineTool: (x) => x }))) if (d?.name) names.push(d.name)
  }
  return names
}

/** 同上，但把 qq_say_in_group 这个工具定义取出来 */
export function sayToolFor (toolFns, chat, level = 'full') {
  for (const fn of toolFns) {
    for (const d of asList(fn({ chat, level, defineTool: (x) => x }))) if (d?.name === 'qq_say_in_group') return d
  }
  return null
}

export async function boot (opts) {
  const ctx = makeApi(opts)
  mod.setup(ctx.api)
  // setup 里有一次 get_group_list 的异步补群名，等它落地
  await new Promise((r) => setTimeout(r, 0))
  return ctx
}

/** 跑一次「发群排队补发」的扫描（模块里是 api.every，测试里存下了回调） */
export async function drain (ctx) {
  const t = ctx.timers.find((x) => x.label === '发群排队补发')
  assert.ok(t, '模块应该注册了补发定时器')
  await t.fn()
}

export function readOutbox (dataDir) {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'outbox.json'), 'utf8'))
  } catch {
    return []
  }
}

export const SYSTEM_CHAT = { kind: 'system', id: 'sys-1' }
export const PRIVATE_CHAT = { kind: 'private', id: 'private:1250226509' }
export const GROUP_CHAT = { kind: 'group', id: 'group:1034185861' }
export const GROUP_ID = '1034185861'
/** 她自己（makeApi 里的 botQQ） */
export const SELF = '1250226509'
/** 秒级时间戳，往前推 minutes 分钟 */
export const ago = (minutes) => Math.floor((Date.now() - minutes * 60_000) / 1000)
