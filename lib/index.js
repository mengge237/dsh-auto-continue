// dsh-auto-continue v0.4.0 — max-tokens 自动续写 + 429/限流自动恢复 + 压缩空转补枪
//
// 挂点（对 0.1.2-rc.1 编译产物实证）：
//   · 根作用域 ctx.on('agent/status')  —— 官方插件（compaction-basic / goal-round-driver /
//     sdk-jsonrpc-server）同款用法；agentEvents() 会把 agent 融进 payload，
//     所以 ({agent, status}) 一定拿得到 Agent 实例。
//   · turn/end 在 turn() 的 finally 里落盘，kick() 的 finally 才 setPhase(idle)，
//     所以收到 idle 时尾部 turn/end 已经写好，读它是安全的。
//   · 会话事件自带 time（epoch ms），用它算真实冷却/新鲜度。
//
// v0.3.1 相对 v0.3 的修正（全部有源码/实测依据）：
//   1) 造消息不再依赖 `import('@deepseek-ai/dsh-llm')`：插件装在 profile 目录，
//      Node 从插件 realpath 向上找不到该包（实测 ERR_MODULE_NOT_FOUND），
//      v0.3 的兜底对象缺 `role`/`id` → 投进收件箱的是残缺消息。现在本地构造完整
//      user message（role/id/content/source，冻结），能解析到官方 createUserMessage 时仍优先用。
//   2) `inbox.hasPending` 是 boolean getter 而不是函数，v0.3 写成
//      `typeof hasPending === 'function'` → 守卫恒假（"尊重用户正在打的字"形同虚设）。已修。
//   3) 429 熔断：连续 429 自动重试最多 DSH_TP_429_MAX_RETRIES 次（默认 3），
//      之后停手等用户——v0.3 每次重试都开新回合，去重挡不住，会 4 次/分钟无限重试。
//   4) 冷却时间按 turn/end 的 time 真实计算（v0.3 的 `Math.max(COOLDOWN - pacing, COOLDOWN)`
//      恒等于 COOLDOWN，pacing 白写），并把真实等待秒数写进提示文案。
//   5) 新鲜度窗口：只对 DSH_AUTO_CONTINUE_STALE_MS（默认 10 分钟）内的截断/限流动手，
//      避免重启/恢复老会话时突然补发"请重新执行上一条请求"。
//   6) 发送前二次确认 agent 仍 idle（别的输入已经唤醒就不重复投）。
//   7) 导出 name（cordis 运行时按 name 记账/日志，v0.3 只有局部常量）。
//
// v0.4.0 新增「压缩空转补枪」（本机 69 份存档 / 29 次压缩实测归因）：
//   13 次压缩后照常干活；7 次"只回一句就被 max-tokens 截断"，旧分支能救回来；
//   但有 3 次长这样：turn/start → user[plugin:compact] → END[completed]，
//   间隔只有 10~21ms，中间零条 assistant、零次工具 —— 压缩事务把这一整轮吞了
//   （compaction-basic 自己的日志就在说 "shadowed N surface nodes"，原本排在
//   这一轮的续写被连带 shadow 掉）。这种 turn/end 的 kind 是 completed，
//   旧版直接放行，于是会话就那么停着，实测最长 8 分 13 秒后靠人工再发一句才动起来。
//   现在按形状识别并补发一次「照检查点继续动手」，仍受 MAX_PER_MIN、新鲜度、
//   inbox 待输入、同回合去重这几层约束。
//
// 环境变量：
//   DSH_AUTO_CONTINUE=0              整体关闭
//   DSH_AUTO_CONTINUE_MAX=4          每 agent 每 60s 最多自动续写次数
//   DSH_AUTO_CONTINUE_STALE_MS=600000 只对 N 毫秒内的 turn/end 动手
//   DSH_TP_429_COOLDOWN_MS=60000     429 冷却（自 turn/end 起算）
//   DSH_TP_429_MAX_RETRIES=3         连续 429 自动重试上限（熔断）
//   DSH_TP_PACING_MS=2500            全局最小发送间隔（另加 0~1.5s 抖动）
//   DSH_TP_REMINDER=1                429 恢复消息带"仅本会话提示"文案
//   DSH_AUTO_CONTINUE_CP_WINDOW_MS=60000 检查点→turn/end 的最大间隔，超过就不算"压缩吞轮"
//   DSH_AUTO_CONTINUE_LOG=<path>     额外把决策写进行日志（默认 ~/.dsh/auto-continue.log；设为 off/0/空 关闭）
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-auto-continue'

const num = (raw, dflt, min) => {
  const n = Number(raw)
  if (!Number.isFinite(n)) return dflt
  return n < min ? min : n
}

const ENABLED = process.env.DSH_AUTO_CONTINUE !== '0'
const MAX_PER_MIN = num(process.env.DSH_AUTO_CONTINUE_MAX, 4, 1)
const STALE_MS = num(process.env.DSH_AUTO_CONTINUE_STALE_MS, 600_000, 5_000)
const COOLDOWN_MS = num(process.env.DSH_TP_429_COOLDOWN_MS, 60_000, 200)
/** 429 重试的最短等待（策略值，不是物理量）；rig 里设 0 可以同步验证重试落不落地。 */
const MIN_WAIT_MS = num(process.env.DSH_TP_429_MIN_WAIT_MS, 1_000, 0)
const MAX_429_RETRIES = num(process.env.DSH_TP_429_MAX_RETRIES, 3, 0)
const PACING_MS = num(process.env.DSH_TP_PACING_MS, 2_500, 200)
const REMINDER = process.env.DSH_TP_REMINDER !== '0'
const SCAN_WINDOW = 200
/** 压缩检查点的消息归属（dsh-compaction 的 COMPACT_CHECKPOINT_MARKER：source {kind:'plugin',plugin:'compact'}）。 */
const CHECKPOINT_PLUGIN = 'compact'
/** 检查点落地到 turn/end 间隔超过这个就认为不是"压缩吞轮"，别乱补。 */
const CP_WINDOW_MS = num(process.env.DSH_AUTO_CONTINUE_CP_WINDOW_MS, 60_000, 1_000)

const LOG_FILE = (() => {
  const raw = process.env.DSH_AUTO_CONTINUE_LOG
  if (raw === 'off' || raw === '0' || raw === '') return null
  try {
    return raw || join(homedir(), '.dsh', 'auto-continue.log')
  } catch {
    return null
  }
})()

/**
 * 造一条完整的 user 消息。
 * 刻意**同步**且零外部依赖：`ctx.agents`/`followup` 这类 service 只能在 fiber 活跃的
 * 同一拍里取（一旦 `await` 过，dispatch 结束、context 变 inactive，就会抛
 * `cannot get required service "agents" in inactive context` —— ac-rig 实测）。
 * 所以这里不能动态 import；本地构造与 `@deepseek-ai/dsh-llm` 的
 * `createUserMessage`（`{...input, role:'user', id:brandString(randomUUID())}` + 深冻结）等价。
 */
function makeMessage(text) {
  return Object.freeze({
    role: 'user',
    id: randomUUID(),
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'plugin', plugin: name }),
  })
}

/** 兜底消息缺 role/id 会让收件箱拿到残缺消息；这里统一体检一次。 */
function assertMessage(msg) {
  if (!msg || msg.role !== 'user' || !msg.id) {
    const err = new Error('dsh-auto-continue: 生成的消息不完整（role/id 缺失）')
    err.code = 'AUTO_CONTINUE_BAD_MESSAGE'
    throw err
  }
  return msg
}

const CONTINUE_TEXT = '（自动续写）请直接从上次断点继续输出。'
/** 压缩事务吞掉一整轮时用这条：检查点里带着 Pending Jobs / Next Step，照它接着干就行。 */
const CHECKPOINT_CONTINUE_TEXT =
  '（自动续写）上下文刚压缩完，而这一轮在压缩事务里没有任何产出就结束了。' +
  '请按检查点里的 Pending Jobs / Next Step 直接继续动手，不要复述确认、不要重新总结一遍。'
const retryText = (sec) =>
  '（阿里 token-plan 429 限流已过：已自动等待 ' + sec + ' 秒后恢复，仅本会话提示，其它对话不受影响）请重新执行我上一条请求。'

// 真·可恢复限流：TPM 打满（阿里文案 "Allocated quota exceeded … #token-limit"，HTTP 429）。
const RATE_LIMITED = /\b429\b|allocated quota exceeded|token-limit|rate.?limit|too many requests|Please retry later/i
// 不可恢复的额度失败：重试只会白白占坑，必须交给人（免费额度耗尽 / 余额不足 / 需要充值）。
const DEAD_QUOTA = /free quota exhausted|use free tier only|insufficient balance|please add funds|余额不足|充值/i

/** 429/token-limit 判定（对 0.1.2-rc.1 分类补丁后的真实 turn/end 语料实证）。 */
const is429 = (reason) => {
  if (!reason || reason.kind !== 'error') return false
  const err = reason.error || {}
  const code = String(err.code || '')
  const msg = String(err.message || '')
  if (DEAD_QUOTA.test(msg)) return false
  if (code === 'RATE_LIMIT') return RATE_LIMITED.test(msg)
  if (code === 'QUOTA') return RATE_LIMITED.test(msg)
  return /\b429\b|token-limit|allocated quota exceeded/i.test(msg)
}

/** 读 agent 会话尾部事件（压缩检查点与 turn/end 判定共用一份）。 */
function snapshotOf(agent) {
  const s = agent?.session
  if (!s) return null
  let evs = null
  try {
    if (typeof s.snapshotEvents === 'function') evs = s.snapshotEvents()
    else if (Array.isArray(s.events)) evs = s.events
  } catch {
    evs = null
  }
  return Array.isArray(evs) && evs.length ? evs : null
}

/** 读 agent 会话尾部最近一次 turn/end（自带 time；无 time 当作刚刚发生）。 */
function lastTurnEnd(agent) {
  const evs = snapshotOf(agent)
  if (!evs) return null
  const now = Date.now()
  for (let i = evs.length - 1, seen = 0; i >= 0 && seen < SCAN_WINDOW; i -= 1, seen += 1) {
    const e = evs[i]
    if (e?.type !== 'turn/end') continue
    const data = e.data || {}
    const time = Number(e.time)
    return {
      reason: data.reason || null,
      turn: data.turn,
      eventSeq: e.seq ?? i,
      at: Number.isFinite(time) ? time : now,
    }
  }
  return null
}

const isCompactCheckpoint = (e) => {
  if (!e || e.type !== 'user/message') return false
  const s = e.data?.source || {}
  return s.kind === 'plugin' && s.plugin === CHECKPOINT_PLUGIN
}

/**
 * 「压缩把这一整轮吞了」判定（本机 2026-09-05~07 存档实证，29 次压缩里 3 次这种收尾）：
 *   turn/start → user[plugin:compact] → END[completed]，中间 0 条 assistant、0 次 tool，
 *   间隔只有 10~21ms。也就是检查点在轮内落地后，harness 直接结束了这一轮，
 *   连一次模型调用都没有；原本排在这轮的续写被压缩事务 shadow 掉（compaction-basic
 *   自己的日志就说 "shadowed N surface nodes"）。没有这一条，会话就只能等人工再发一句。
 * 只在**严格满足该形状**时返回，任何有产出的轮次一律返回 null（不干扰正常收尾）。
 */
function tailCompactionStall(agent) {
  const evs = snapshotOf(agent)
  if (!evs) return null
  const start = Math.max(0, evs.length - SCAN_WINDOW)
  let endIdx = -1
  for (let i = evs.length - 1; i >= start; i -= 1) {
    if (evs[i]?.type === 'turn/end') { endIdx = i; break }
  }
  if (endIdx < 0) return null
  const end = evs[endIdx]
  const data = end.data || {}
  const reason = data.reason || {}
  if (reason.kind !== 'completed') return null // 截断/限流各有分支，aborted 多半是人按的停
  let cpAt = null
  let replies = 0
  let tools = 0
  for (let i = endIdx - 1; i >= start; i -= 1) {
    const e = evs[i]
    if (!e) continue
    if (isCompactCheckpoint(e)) {
      cpAt = Number(e.time)
      break
    }
    const t = e.type
    if (t === 'turn/end' || t === 'turn/start' || t === 'user/message') return null // 出轮了，检查点不属这一轮
    if (t === 'assistant/message') replies += 1
    else if (t === 'tool/call' || t === 'tool/result') tools += 1
  }
  if (cpAt === null || !Number.isFinite(cpAt)) return null
  if (replies > 0 || tools > 0) return null // 真干了活就不算空转
  const gap = (Number(end.time) || Date.now()) - cpAt
  if (gap < 0 || gap > CP_WINDOW_MS) return null
  return { at: cpAt, gap, turn: data.turn, eventSeq: end.seq ?? endIdx }
}

export function apply(ctx) {
  if (!ENABLED) return
  /** agentId -> { handledTurn, count, winStartAt, lastSentAt, retries, sent } */
  const state = new Map()
  let lastAnySendAt = 0

  const log = (level, ...args) => {
    const line = new Date().toISOString() + ' ' + level + ' ' + args.join(' ')
    if (LOG_FILE) {
      try {
        appendFileSync(LOG_FILE, line + '\n')
      } catch {
        /* 日志写失败不影响主流程 */
      }
    }
    const logger = ctx?.logger
    if (logger && typeof logger[level] === 'function') {
      try {
        logger[level](name, ...args)
        return
      } catch {}
    }
    try {
      console.error('[' + name + ']', level, ...args)
    } catch {}
  }

  const record = (agentId) => {
    const now = Date.now()
    let rec = state.get(agentId)
    if (!rec) {
      rec = { handledTurn: null, count: 0, winStartAt: now, lastSentAt: 0, retries: 0, sent: 0 }
      state.set(agentId, rec)
    }
    if (now - rec.winStartAt > 60_000) {
      rec.winStartAt = now
      rec.count = 0
    }
    return rec
  }

  /**
   * 投递一条续写消息。**同步**执行：`agent.followup` 内部要取 `agents` service，
   * 只有当前 fiber 还在活跃的那一帧里才取得到（ac-rig 实测：await 过就抛
   * `cannot get required service "agents" in inactive context`）。
   */
  const deliver = (agent, rec, text, tag) => {
    const release = () => {
      rec.count = Math.max(0, rec.count - 1) // 让出预占额度
    }
    try {
      if (agent.inbox?.hasPending) {
        log('info', agent.id, '收件箱已有待处理输入，放弃本次' + tag)
        release()
        return false
      }
      if (agent.status && agent.status !== 'idle') {
        log('info', agent.id, 'agent 已重新运行，放弃本次' + tag)
        release()
        return false
      }
      const msg = assertMessage(makeMessage(text))
      if (typeof agent.followup === 'function') agent.followup(msg)
      else if (typeof agent.steer === 'function') agent.steer(msg)
      else {
        log('warn', agent.id, 'agent 既无 followup 也无 steer，无法续写')
        release()
        return false
      }
      const now = Date.now()
      rec.lastSentAt = now
      rec.sent += 1
      lastAnySendAt = now
      log('info', agent.id, '已自动续写 #' + rec.sent + '（' + tag + '，回合 ' + rec.handledTurn + '）')
      return true
    } catch (err) {
      release()
      log('warn', agent.id, '自动续写失败: ' + (err?.message || err))
      return false
    }
  }

  const dispatch = (agent, rec, text, delayMs, tag) => {
    if (!(delayMs > 0)) return deliver(agent, rec, text, tag)
    setTimeout(() => deliver(agent, rec, text, tag), delayMs)
    return true
  }

  try {
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || !agent) return
      const agentId = agent.id ?? String(agent)
      const end = lastTurnEnd(agent)
      if (!end || !end.reason) return
      const kind = end.reason.kind
      const rec = record(agentId)
      const rateLimited = is429(end.reason)
      // 压缩事务把整轮吞了的时候，turn/end 长得跟正常收尾一模一样（completed），
      // 只能靠形状认：本轮最后一个输入是检查点、之后零回复零工具。
      const cpStall = kind === 'completed' && !rateLimited ? tailCompactionStall(agent) : null
      if (kind !== 'max-tokens' && !rateLimited && !cpStall) {
        if (rec.retries) rec.retries = 0 // 正常推进就解除 429 熔断计数
        return
      }
      const now = Date.now()
      const age = Math.max(0, now - end.at)
      if (age > STALE_MS) {
        log('info', agentId, '忽略过期回合（turn ' + end.turn + '，' + Math.round(age / 1000) + 's 前）')
        return
      }
      if (rec.handledTurn === end.turn) return // 同一回合只处理一次
      if (rateLimited) {
        if (rec.retries >= MAX_429_RETRIES) {
          log('warn', agentId, '连续 429 自动重试已达上限 ' + MAX_429_RETRIES + ' 次，停手等你手动继续')
          return
        }
        rec.retries += 1
      } else if (rec.count + 1 > MAX_PER_MIN) {
        log('info', agentId, '自动续写达上限 ' + MAX_PER_MIN + '/min，等用户')
        return
      }
      rec.handledTurn = end.turn
      rec.count += 1 // 预占额度：延迟发送期间也不允许再排第二发
      const pacing = Math.max(0, PACING_MS - (now - lastAnySendAt))
      if (rateLimited) {
        const remaining = Math.max(COOLDOWN_MS - age, MIN_WAIT_MS)
        // 冷却还没过就定时器等；冷却已经过了就在这一帧里同步投递（别把活跃 context 用掉）。
        const wait = remaining + pacing + (remaining > 0 ? Math.random() * 1_500 : 0)
        log('warn', agentId, '检测到 429/token-limit（turn ' + end.turn + '）→ ' + (wait >= 1000 ? Math.round(wait / 1000) + 's 后' : wait > 0 ? Math.round(wait) + 'ms 后' : '立即') + '自动重试（第 ' + rec.retries + '/' + MAX_429_RETRIES + ' 次）')
        const seconds = Math.max(1, Math.round(wait / 1000))
        const text = !REMINDER
          ? '请重新执行我上一条请求。'
          : wait >= 1000
            ? retryText(seconds)
            : '（token-plan 限流已恢复：冷却已过，仅本会话提示，其它对话不受影响）请重新执行我上一条请求。'
        void dispatch(agent, rec, text, wait, '429 恢复')
      } else if (cpStall) {
        log('info', agentId, '压缩检查点后零产出收尾（turn ' + end.turn + '，检查点之后 ' + cpStall.gap + 'ms 就 end 了）→ 补发续写')
        void dispatch(agent, rec, CHECKPOINT_CONTINUE_TEXT, pacing, '压缩空转续写')
      } else {
        // max-tokens 没有冷却可言：留在这一帧里同步投递，续写立刻开下一回合。
        log('info', agentId, 'max-tokens 截断（turn ' + end.turn + '）→ 同步自动续写')
        void dispatch(agent, rec, CONTINUE_TEXT, pacing, 'max-tokens 续写')
      }
    })
    log('info', '已挂载（v0.4.0）：max-tokens 自动续写 + 429 自动恢复 + 压缩空转补枪；上限 ' + MAX_PER_MIN + '/min，429 冷却 ' + Math.round(COOLDOWN_MS / 1000) + 's×' + MAX_429_RETRIES + '，新鲜度 ' + Math.round(STALE_MS / 1000) + 's，压缩窗口 ' + Math.round(CP_WINDOW_MS / 1000) + 's，日志 ' + (LOG_FILE || 'off'))
  } catch (err) {
    log('warn', 'agent/status 监听注册失败: ' + (err?.message || err))
  }
}

