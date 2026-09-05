// dsh-auto-continue v0.2 — max-tokens 自动续写 + tokenplan 429/并发分级排队
//
// 解决两类“服务被打断”：
//  A) max-tokens 截断 → 自动补“请继续”（v0.1）；
//  B) 阿里 token-plan 429 (Allocated quota exceeded / token-limit) 与多会话并发 →
//     分级：轻活照跑；重活/新请求按 MAX_PARALLEL 排队，429 冷却 ~60s 后自动恢复，
//     恢复时只在“触发它的那个会话”里发一条带提醒的续写消息（其它会话不显示、不受影响）。
//
// 机制（dsh 0.1.2-rc.1 实证）：
//   - session/event 观察 turn/start|turn/end(含 reason)、step/start；
//     agent/status=idle 时用 agent.followup() 唤醒下一回合（idle 后 followup 才可靠开新回合）。
//   - 会话分级：近 60s step ≥HEAVY_STEPS_PER_MIN 且为 tokenplan 记 heavy；
//     429 后该会话进入冷却；全局同跑会话数超 TP_MAX_PARALLEL 时新请求排队。
//   - 只对“自己管理的 agent”调用 followup → 提醒只出现在对应工作会话，其它对话不显示。
//
// 守卫：每分钟次数上限、冷却、收件箱有输入不续、全 try/catch 只记日志。
// 环境变量：
//   DSH_AUTO_CONTINUE=0           整体关闭
//   DSH_AUTO_CONTINUE_MAX=4       每 agent 每 60s 最多自动续次数
//   DSH_TP_MAX_PARALLEL=2         tokenplan 同跑会话上限（排队基准）
//   DSH_TP_429_COOLDOWN_MS=60000  429 后冷却
//   DSH_TP_PACING_MS=2000         自动续写最小间隔（+0~1500 抖动）
//   DSH_TP_REMINDER=1             排队/冷却时在触发会话发带提醒的续写消息
const name = 'dsh-auto-continue'

const ENABLED = process.env.DSH_AUTO_CONTINUE !== '0'
const MAX_PER_MIN = Number(process.env.DSH_AUTO_CONTINUE_MAX || 4)
const MIN_INTERVAL_MS = 1200
const TP_MAX_PARALLEL = Math.max(1, Number(process.env.DSH_TP_MAX_PARALLEL || 2))
const TP_429_COOLDOWN_MS = Math.max(1000, Number(process.env.DSH_TP_429_COOLDOWN_MS || 60000))
const TP_PACING_MS = Math.max(200, Number(process.env.DSH_TP_PACING_MS || 2000))
const TP_REMINDER = process.env.DSH_TP_REMINDER !== '0'
const HEAVY_STEPS_PER_MIN = 6

function say(ctx, level, ...args) {
  const logger = ctx?.logger
  if (logger && typeof logger[level] === 'function') {
    try { logger[level](name, ...args); return } catch {}
  }
  try { console.error('[' + name + ']', level, ...args) } catch {}
}

async function makeMessage(text) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    const fn = mod?.createUserMessage
    if (typeof fn === 'function') {
      return fn({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: name } })
    }
  } catch {}
  return { content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: name } }
}

const CONTINUE_TEXT = '（自动续写）请直接从上次断点继续输出。'
const WAIT_TEXT = (sec, why, tail = '请继续刚才的任务。') =>
  '（' + why + '：已自动等待 ' + sec + ' 秒后恢复，仅本会话提示，其它对话不受影响）' + tail

export function apply(ctx) {
  if (!ENABLED) return
  const state = new Map() // sid -> {agent,count,windowStartAt,lastSentAt,pending,steps,stepsWin,last429At,remindedAt,queueNotified,paused,active,sessionEndsAt}
  let lastAnySendAt = 0

  const sidOf = (agent) => agent?.session?.header?.id || agent?.id || null

  const activeParallel = () => {
    const now = Date.now()
    let n = 0
    for (const r of state.values()) {
      if (r.active === true || (r.sessionEndsAt != null && now - r.sessionEndsAt < 15000)) n += 1
    }
    return n
  }

  const freeAgent = async (sid) => {
    const rec = state.get(sid)
    if (!rec || rec.pending !== true || !rec.agent) return
    const now = Date.now()
    const cooling = rec.last429At != null && now - rec.last429At < TP_429_COOLDOWN_MS
    const parallel = activeParallel()
    if (cooling) {
      rec.paused = true
      if (TP_REMINDER && rec.remindedAt !== rec.last429At) {
        rec.remindedAt = rec.last429At
        say(ctx, 'info', sid, '429 冷却中，排队 ~' + Math.ceil((TP_429_COOLDOWN_MS - (now - rec.last429At)) / 1000) + 's')
      }
    } else if (parallel >= TP_MAX_PARALLEL) {
      rec.paused = true
      if (TP_REMINDER && rec.queueNotified !== true) {
        rec.queueNotified = true
        say(ctx, 'info', sid, '并发排队中（当前 tokenplan 会话数 ' + parallel + ' ≥ ' + TP_MAX_PARALLEL + '）')
      }
    } else {
      rec.paused = false
      rec.queueNotified = false
    }
    const pacing = Math.max(0, TP_PACING_MS - (now - lastAnySendAt)) + Math.random() * 1500
    const minGap = rec.lastSentAt ? Math.max(0, MIN_INTERVAL_MS - (now - rec.lastSentAt)) : 0
    let waitMs = Math.max(cooling ? TP_429_COOLDOWN_MS - (now - rec.last429At) : 0,
      rec.paused && !cooling ? 6000 + Math.random() * 3000 : 0, pacing, minGap)
    if (now - rec.windowStartAt > 60000) { rec.windowStartAt = now; rec.count = 0 }
    if (rec.count >= MAX_PER_MIN) {
      say(ctx, 'info', sid, '已达自动续写上限 ' + MAX_PER_MIN + '/min，等用户')
      state.delete(sid)
      return
    }
    setTimeout(async () => {
      try {
        const r2 = state.get(sid)
        if (!r2 || r2.pending !== true) return
        const now2 = Date.now()
        const stillCool = r2.last429At != null && now2 - r2.last429At < TP_429_COOLDOWN_MS
        if (stillCool || activeParallel() >= TP_MAX_PARALLEL) {
          say(ctx, 'info', sid, '条件仍未就绪（限流/并发），放弃本轮自动恢复，避免空转')
          state.delete(sid)
          return
        }
        const agent = r2.agent
        const inbox = agent?.inbox
        if (typeof inbox?.hasPending === 'function' && inbox.hasPending) { state.delete(sid); return }
        let text = CONTINUE_TEXT
        if (r2.last429At != null) text = WAIT_TEXT(Math.round((now2 - r2.last429At) / 1000), '阿里 token-plan 429 限流已过', '请重新执行我上一条请求（刚才因限流失败）。')
        else if (r2.queueNotified) text = WAIT_TEXT(Math.round(waitMs / 1000), '多会话并发排队已过')
        const msg = await makeMessage(text)
        r2.pending = false
        r2.count += 1
        r2.lastSentAt = Date.now()
        lastAnySendAt = r2.lastSentAt
        try {
          if (typeof agent.followup === 'function') agent.followup(msg)
          else if (typeof agent.steer === 'function') agent.steer(msg)
          else { state.delete(sid); return }
          say(ctx, 'info', sid, '已自动恢复 #' + r2.count + (text.includes('429') || text.includes('排队') ? '（含本会话提醒）' : ''))
        } catch (err) {
          say(ctx, 'warn', sid, '自动恢复发送失败: ' + (err?.message || err))
          state.delete(sid)
        }
      } catch (err) {
        say(ctx, 'warn', sid, '自动恢复异常: ' + (err?.message || err))
      }
    }, waitMs)
  }

  const touch = (sid, agent) => {
    let rec = state.get(sid)
    if (!rec) {
      rec = { agent, count: 0, windowStartAt: Date.now(), lastSentAt: 0, pending: false, steps: 0, stepsWin: Date.now(), grade: 'light', last429At: 0, remindedAt: 0, queueNotified: false, paused: false, active: false, sessionEndsAt: null }
      state.set(sid, rec)
    }
    rec.agent = agent
    return rec
  }

  try {
    ctx.on('session/event', (session, event) => {
      if (!event) return
      const t = event.type
      if (t !== 'turn/start' && t !== 'turn/end' && t !== 'step/start') return
      const sid = session?.header?.id
      if (!sid) return
      const rec = touch(sid, null)
      const now = Date.now()
      if (t === 'step/start') {
        rec.steps += 1
        if (now - rec.stepsWin > 60000) { rec.steps = 1; rec.stepsWin = now }
        if (rec.steps >= HEAVY_STEPS_PER_MIN && rec.grade !== 'heavy') { rec.grade = 'heavy'; say(ctx, 'info', sid, '分级=heavy（近1分钟步骤多）') }
      } else if (t === 'turn/start') {
        rec.active = true
        rec.sessionEndsAt = null
      } else if (t === 'turn/end') {
        rec.active = false
        rec.sessionEndsAt = now
        const reason = event.data?.reason
        const em = reason?.error?.message || reason?.message || ''
        if (reason?.kind === 'max-tokens') {
          rec.pending = true
          say(ctx, 'info', sid, 'max-tokens 截断 → 准备自动续写')
        } else if (reason?.kind === 'error' && /429|Allocated quota|token-limit|insufficient_quota/.test(em)) {
          rec.last429At = now
          rec.paused = true
          rec.pending = true // v0.2.1：429 也要排队等冷却后自动重试（否则不会自动恢复）
          say(ctx, 'warn', sid, '检测到阿里 429 token-limit → 冷却 ' + Math.round(TP_429_COOLDOWN_MS / 1000) + 's 后自动重试')
        }
      }
    })
  } catch (err) {
    say(ctx, 'warn', 'session/event 监听注册失败: ' + (err?.message || err))
  }

  try {
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || !agent) return
      const sid = sidOf(agent)
      if (!sid) return
      touch(sid, agent)
      if (state.get(sid)?.pending !== true) return
      freeAgent(sid).catch((err) => say(ctx, 'warn', 'freeAgent 异常: ' + (err?.message || err)))
    })
  } catch (err) {
    say(ctx, 'warn', 'agent/status 监听注册失败: ' + (err?.message || err))
  }
}
