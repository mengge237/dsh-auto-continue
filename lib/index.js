// dsh-auto-continue v0.3 — max-tokens 自动续写 + 429/限流自动恢复（稳定输出）
//
// 变更（v0.3）：
//   - 不再依赖 agent 作用域的 session/event（根作用域收不到，v0.2 因此失效）；
//   - 只在根作用域监听 agent/status=idle（dsh-hooks-codex 同款可靠挂点），
//     空闲时直接读 agent.session 尾部最近一次 turn/end 的 reason：
//       kind=max-tokens        → 延迟几百 ms 后 agent.followup('继续')，同回合续写；
//       kind=error 且 429/配额 → 冷却 60s 后自动重发上一条请求。
//   - 去重：按 (agentId, turn) 只处理一次；每 agent 每分钟上限；收件箱有输入不续。
//   - 全局最小发送间隔（TP_PACING_MS，含抖动）平滑多个会话的瞬时 TPM。
//
// 环境变量：
//   DSH_AUTO_CONTINUE=0            整体关闭
//   DSH_AUTO_CONTINUE_MAX=4        每 agent 每 60s 最多自动续次数
//   DSH_TP_429_COOLDOWN_MS=60000   429 后冷却
//   DSH_TP_PACING_MS=2500          自动续写全局最小间隔（+0~1500 抖动）
//   DSH_TP_REMINDER=1              429 恢复消息带"仅本会话提示"文案
const name = 'dsh-auto-continue'

const ENABLED = process.env.DSH_AUTO_CONTINUE !== '0'
const MAX_PER_MIN = Math.max(1, Number(process.env.DSH_AUTO_CONTINUE_MAX || 4))
const TP_429_COOLDOWN_MS = Math.max(1000, Number(process.env.DSH_TP_429_COOLDOWN_MS || 60000))
const TP_PACING_MS = Math.max(200, Number(process.env.DSH_TP_PACING_MS || 2500))
const TP_REMINDER = process.env.DSH_TP_REMINDER !== '0'
const SCAN_WINDOW = 80

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
const RETRY_TEXT = (sec) =>
  '（阿里 token-plan 429 限流已过：已自动等待 ' + sec + ' 秒后恢复，仅本会话提示，其它对话不受影响）请重新执行我上一条请求。'

/** 读 agent 会话尾部最近一次 turn/end，返回 {reason, turn, eventSeq} 或 null。 */
function lastTurnEnd(agent) {
  const s = agent?.session
  if (!s) return null
  let evs = null
  try {
    if (typeof s.snapshotEvents === 'function') evs = s.snapshotEvents()
    else if (Array.isArray(s.events)) evs = s.events
  } catch { evs = null }
  if (!Array.isArray(evs) || evs.length === 0) return null
  for (let i = evs.length - 1; i >= 0 && evs.length - 1 - i <= SCAN_WINDOW; i -= 1) {
    const e = evs[i]
    if (e?.type !== 'turn/end') continue
    const data = e.data || {}
    return { reason: data.reason || null, turn: data.turn, eventSeq: e.seq ?? i }
  }
  return null
}

export function apply(ctx) {
  if (!ENABLED) return
  const state = new Map() // agentId -> {turnHandled, count, winStartAt, lastSentAt}
  let lastAnySendAt = 0

  const bump = (agentId, turn) => {
    const now = Date.now()
    const rec = state.get(agentId) || { turnHandled: -1, count: 0, winStartAt: now, lastSentAt: 0 }
    if (rec.turnHandled === turn) return null // 已处理过该回合
    if (now - rec.winStartAt > 60000) { rec.winStartAt = now; rec.count = 0 }
    if (rec.count >= MAX_PER_MIN) {
      say(ctx, 'info', agentId, '自动续写达上限 ' + MAX_PER_MIN + '/min，等用户')
      return null
    }
    rec.turnHandled = turn
    state.set(agentId, rec)
    return rec
  }

  const scheduleSend = async (agent, rec, text, delayMs) => {
    const inbox = agent?.inbox
    const doSend = async () => {
      try {
        if (typeof inbox?.hasPending === 'function' && inbox.hasPending) return
        const msg = await makeMessage(text)
        if (typeof agent.followup === 'function') agent.followup(msg)
        else if (typeof agent.steer === 'function') agent.steer(msg)
        else return
        rec.lastSentAt = Date.now()
        lastAnySendAt = rec.lastSentAt
        rec.count += 1
        say(ctx, 'info', agent.id, '已自动续写 #' + rec.count + (text.includes('429') ? '（429 恢复）' : '（max-tokens 续写）'))
      } catch (err) {
        say(ctx, 'warn', agent.id, '自动续写发送失败: ' + (err?.message || err))
      }
    }
    setTimeout(doSend, delayMs)
  }

  try {
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || !agent) return
      const agentId = agent.id
      if (!agentId) return
      const end = lastTurnEnd(agent)
      if (!end || !end.reason) return
      const now = Date.now()
      const is429 = end.reason.kind === 'error' && /429|Allocated quota|token-limit|insufficient_quota/.test((end.reason.error?.message) || '')
      if (end.reason.kind !== 'max-tokens' && !is429) return
      const rec = bump(agentId, end.turn)
      if (!rec) return
      // 全局错峰
      const pacing = Math.max(0, TP_PACING_MS - (now - lastAnySendAt)) + Math.random() * 1500
      if (is429) {
        const wait = Math.max(TP_429_COOLDOWN_MS - pacing, TP_429_COOLDOWN_MS)
        say(ctx, 'warn', agentId, '检测到 429/token-limit → ' + Math.round(wait / 1000) + 's 后自动重试')
        scheduleSend(agent, rec, TP_REMINDER ? RETRY_TEXT(Math.round(wait / 1000)) : '请重新执行我上一条请求。', wait)
      } else {
        say(ctx, 'info', agentId, 'max-tokens 截断 → 自动续写')
        scheduleSend(agent, rec, CONTINUE_TEXT, 300 + pacing)
      }
    })
  } catch (err) {
    say(ctx, 'warn', 'agent/status 监听注册失败: ' + (err?.message || err))
  }
}
