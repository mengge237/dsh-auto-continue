// Headless regression test for the dsh-auto-continue plugin (0 LLM tokens).
//   node --test ~/dsh-fixes/test_auto_continue.js
// Fakes the two dsh surfaces the plugin touches:
//   ctx.on("agent/status", ({ agent, status }))   (root scope)
//   agent.session.snapshotEvents() / agent.followup() / agent.inbox.hasPending
import test from 'node:test'
import assert from 'node:assert/strict'

const MOD = process.env.DSH_AC_MOD
  || 'file:///E:/S_Software/deepseek-harness/plugins/dsh-auto-continue/lib/index.js'

function fakeAgent({ reason, turn = 3, hasPending = false }) {
  return {
    id: 'agent-test',
    sent: [],
    session: { snapshotEvents: () => [{ type: 'turn/end', seq: 99, data: { turn, reason } }] },
    inbox: { hasPending },
    followup(msg) { this.sent.push(msg) },
  }
}

function fakeCtx() {
  const handlers = {}
  const logs = []
  return {
    handlers,
    logs,
    ctx: {
      on(evt, fn) { handlers[evt] = fn },
      logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]) },
    },
  }
}

let seq = 0
async function load(env) {
  Object.assign(process.env, { DSH_AUTO_CONTINUE: '1', ...env })
  seq += 1
  const mod = await import(`${MOD}?n=${seq}`)
  assert.equal(typeof mod.apply, 'function', 'module must export apply()')
  return mod
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const textOf = (msg) => (msg?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')

test('max-tokens truncation triggers an automatic follow-up', async () => {
  const { apply } = await load({ DSH_TP_PACING_MS: '200' })
  const { ctx, handlers, logs } = fakeCtx()
  apply(ctx)
  assert.ok(handlers['agent/status'], 'agent/status listener must be registered')
  const agent = fakeAgent({ reason: { kind: 'max-tokens' } })
  handlers['agent/status']({ agent, status: 'idle' })
  await sleep(1800)
  assert.equal(agent.sent.length, 1, 'exactly one auto-continue message')
  assert.match(textOf(agent.sent[0]), /继续/, 'text asks to continue')
  assert.equal(agent.sent[0].source.kind, 'plugin')
  assert.equal(agent.sent[0].source.plugin, 'dsh-auto-continue')
  assert.ok(logs.some((l) => JSON.stringify(l).includes('已自动续写')), 'logs the send')
})

test('a completed turn does nothing', async () => {
  const { apply } = await load({})
  const { ctx, handlers } = fakeCtx()
  apply(ctx)
  const agent = fakeAgent({ reason: { kind: 'completed' } })
  handlers['agent/status']({ agent, status: 'idle' })
  await sleep(700)
  assert.equal(agent.sent.length, 0)
})

test('running status does nothing', async () => {
  const { apply } = await load({})
  const { ctx, handlers } = fakeCtx()
  apply(ctx)
  const agent = fakeAgent({ reason: { kind: 'max-tokens' } })
  handlers['agent/status']({ agent, status: 'running' })
  await sleep(700)
  assert.equal(agent.sent.length, 0)
})

test('same turn is handled once (no double send)', async () => {
  const { apply } = await load({ DSH_TP_PACING_MS: '200' })
  const { ctx, handlers } = fakeCtx()
  apply(ctx)
  const agent = fakeAgent({ reason: { kind: 'max-tokens' }, turn: 7 })
  handlers['agent/status']({ agent, status: 'idle' })
  handlers['agent/status']({ agent, status: 'idle' })
  await sleep(1800)
  assert.equal(agent.sent.length, 1, 'dedupe by (agent, turn)')
})

test('pending user input suppresses the auto-continue', async () => {
  const { apply } = await load({ DSH_TP_PACING_MS: '200' })
  const { ctx, handlers } = fakeCtx()
  apply(ctx)
  const agent = fakeAgent({ reason: { kind: 'max-tokens' }, hasPending: true })
  handlers['agent/status']({ agent, status: 'idle' })
  await sleep(1800)
  assert.equal(agent.sent.length, 0, 'must respect a queued user message')
})

test('429 token-limit error auto-recovers after the cooldown', async () => {
  const { apply } = await load({ DSH_TP_429_COOLDOWN_MS: '700', DSH_TP_PACING_MS: '200' })
  const { ctx, handlers, logs } = fakeCtx()
  apply(ctx)
  const agent = fakeAgent({
    reason: {
      kind: 'error',
      error: {
        message: '429 {"error":{"code":"insufficient_quota","message":"Allocated quota exceeded, please increase your token-limit"}}',
        code: 'RATE_LIMIT',
      },
    },
    turn: 11,
  })
  handlers['agent/status']({ agent, status: 'idle' })
  await sleep(400)
  assert.equal(agent.sent.length, 0, 'must wait out the cooldown')
  await sleep(4500)
  assert.equal(agent.sent.length, 1, 'retries after cooldown')
  assert.match(textOf(agent.sent[0]), /429/, 'reminder mentions 429')
  assert.ok(logs.some((l) => l[0] === 'warn' && JSON.stringify(l).includes('429')), 'warn log for 429 path')
})

test('non-429 errors are not retried', async () => {
  const { apply } = await load({ DSH_TP_429_COOLDOWN_MS: '300' })
  const { ctx, handlers } = fakeCtx()
  apply(ctx)
  const agent = fakeAgent({ reason: { kind: 'error', error: { message: '401 Incorrect API key', code: 'AUTH' } }, turn: 4 })
  handlers['agent/status']({ agent, status: 'idle' })
  await sleep(1300)
  assert.equal(agent.sent.length, 0)
})

test('per-minute cap is enforced across turns', async () => {
  const { apply } = await load({ DSH_AUTO_CONTINUE_MAX: '2', DSH_TP_PACING_MS: '200' })
  const { ctx, handlers, logs } = fakeCtx()
  apply(ctx)
  const agent = fakeAgent({ reason: { kind: 'max-tokens' }, turn: 1 })
  for (const turn of [1, 2, 3, 4]) {
    agent.session = { snapshotEvents: () => [{ type: 'turn/end', seq: turn, data: { turn, reason: { kind: 'max-tokens' } } }] }
    handlers['agent/status']({ agent, status: 'idle' })
    await sleep(60)
  }
  await sleep(2500)
  assert.equal(agent.sent.length, 2, 'capped at DSH_AUTO_CONTINUE_MAX')
  assert.ok(logs.some((l) => JSON.stringify(l).includes('上限')), 'cap is logged')
})

test('DSH_AUTO_CONTINUE=0 disables everything', async () => {
  const { apply } = await load({ DSH_AUTO_CONTINUE: '0' })
  const { ctx, handlers } = fakeCtx()
  apply(ctx)
  assert.equal(Object.keys(handlers).length, 0, 'no listeners when disabled')
})

test('follow-up message is a complete user message (role + id)', async () => {
  const { apply } = await load({ DSH_TP_PACING_MS: '200' })
  const { ctx, handlers } = fakeCtx()
  apply(ctx)
  const agent = fakeAgent({ reason: { kind: 'max-tokens' }, turn: 5 })
  handlers['agent/status']({ agent, status: 'idle' })
  await sleep(1800)
  const msg = agent.sent[0]
  assert.ok(msg, 'message sent')
  assert.equal(msg.role, 'user', 'must carry role (the local fallback drops it)')
  assert.ok(typeof msg.id === 'string' && msg.id.length > 10, 'must carry a stable id')
})
