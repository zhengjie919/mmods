import { test, expect, mock } from 'claude-code/testing'

import { TTL_1H, TTL_5M } from './hooks/state'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const START = 1_000_000
const BIG = 200_000
// The mock clock refuses one advance that resolves more than 10,000 waits; the mod's 120ms tick makes
// that about twenty minutes, so a long wait is walked in ten-minute steps.
const STEP = 10 * MIN

const session = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const paneProps = { bodyColumns: 60, isFocused: true, title: 'Toolbox' }

const usage = (over: Record<string, unknown> = {}) => ({
  input_tokens: 2,
  output_tokens: 1,
  cache_read_input_tokens: BIG,
  cache_creation_input_tokens: 500,
  ...over,
})

// A fork's answer: the failure shapes the mod handles, and a warm readback.
type Answer =
  | null
  | { isAnswered: false; reason: string; status?: number }
  | { isAnswered: true; text: string; usage: ReturnType<typeof usage> }

const warm: Answer = { isAnswered: true, text: '.', usage: usage() }

// The world beneath the mod: its store, the engine's answers, and a fork that replies from a script so
// each test decides what the cache looked like.
function world(on: any, answers: Answer[], opts: { ctx?: number; model?: string; store?: Map<string, unknown> } = {}) {
  const store = opts.store ?? new Map<string, unknown>()
  const entered: string[] = []
  const logs: string[] = []
  const forks: number[] = []
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', ($: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: START, cost: { usd: 0 }, context: { percent: 20, tokens: opts.ctx ?? BIG, window: 1_000_000 } } }))
  on('session.model', () => ({ value: opts.model ?? 'claude-sonnet-5-5' }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', ($: any, e: any) => { logs.push(e.text); return { value: undefined } })
  on('ui.toast', ($: any, e: any) => { logs.push(e.text); return { value: undefined } })
  on('command.register', ($: any, e: any) => ({ value: { command: e.name } }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', ($: any, e: any) => { entered.push(e.text); return { text: e.text } })
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: [''] }))
  on('model.fork', () => {
    forks.push(forks.length)
    const a = answers.shift()
    return { value: a === undefined ? null : a }
  })
  return { store, entered, logs, forks }
}

const turn = (over: Record<string, unknown> = {}) => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer', usage: usage(), ...over })
const prompt = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } })
const run = (command: string, args: string) => ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

async function advance(clock: any, ms: number) {
  for (let left = ms; left > 0; left -= STEP) await clock.advance(Math.min(STEP, left))
}

// Whether the pane (where the stop reason replaces the ping count) shows this text now.
async function paneShows($: any, re: RegExp) {
  const ui = await $.ui.mount({ plugin: 'toolbox', surface: 'terminal', component: 'Pane', requestId: 'toolbox', props: paneProps })
  const el = await ui.find({ text: re })
  await ui.unmount()
  return el !== undefined
}

test('a ping that reads nothing stops the idle loop and shows cold', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, [{ isAnswered: true, text: '.', usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) }])
  await $.session.start(session)
  await $.turn.complete(turn())
  await advance(clock, 5 * MIN)
  expect(w.forks.length).toBe(1)
  // stopped: no retry on the next periods
  await advance(clock, 30 * MIN)
  expect(w.forks.length).toBe(1)
  expect(await paneShows($, /read nothing/)).toBe(true)
})

test('a ping that writes a tenth of what it read stops the idle loop', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, [{ isAnswered: true, text: '.', usage: usage({ cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }) }])
  await $.session.start(session)
  await $.turn.complete(turn())
  await advance(clock, 5 * MIN)
  expect(w.forks.length).toBe(1)
  await advance(clock, 30 * MIN)
  expect(w.forks.length).toBe(1)
  expect(await paneShows($, /cache gone/)).toBe(true)
})

test('a null fork reply stops the idle loop', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, [null])
  await $.session.start(session)
  await $.turn.complete(turn())
  await advance(clock, 5 * MIN)
  expect(w.forks.length).toBe(1)
  await advance(clock, 30 * MIN)
  expect(w.forks.length).toBe(1)
  expect(await paneShows($, /no reply/)).toBe(true)
})

for (const answer of [
  { isAnswered: false, reason: 'aborted' },
  { isAnswered: false, reason: 'api-error', status: 429 },
] as Answer[]) {
  test(`an unanswered fork (${(answer as any).reason}) stops the loop without retrying`, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [answer])
    await $.session.start(session)
    await $.turn.complete(turn())
    await advance(clock, 5 * MIN)
    expect(w.forks.length).toBe(1)
    await advance(clock, 30 * MIN)
    expect(w.forks.length).toBe(1)
  })
}

test('a warm ping keeps the loop and counts itself', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, [warm, warm])
  await $.session.start(session)
  await $.turn.complete(turn())
  await advance(clock, 5 * MIN)
  expect(w.forks.length).toBe(1)
  await advance(clock, 5 * MIN)
  expect(w.forks.length).toBe(2)
  expect(await paneShows($, /♨/)).toBe(true)
})

test('a ping due after the cache expired is skipped, waiting for the next turn', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, [warm])
  await $.session.start(session)
  await $.turn.complete(turn())
  const ui = await $.ui.mount({ plugin: 'toolbox', surface: 'terminal', component: 'Pane', requestId: 'toolbox', props: paneProps })
  // paused over a break: the armed ping is cleared, then the host sleeps well past the lifetime. The
  // pane is let go first so the long advance draws nothing.
  await ui.press({ key: 'pause' })
  await ui.unmount()
  await advance(clock, 30 * MIN)
  // resuming arms a zero wait; the overdue ping runs, sees the cache gone, and does not send. The press
  // waits on that work, so the clock is settled before it is awaited.
  const resumedUi = await $.ui.mount({ plugin: 'toolbox', surface: 'terminal', component: 'Pane', requestId: 'toolbox', props: paneProps })
  const resumed = resumedUi.press({ key: 'pause' })
  await clock.settle()
  await resumed
  expect(w.forks.length).toBe(0)
  expect((await resumedUi.find({ text: /cache went cold/ }))?.text).toMatch(/cache went cold/)
  await resumedUi.unmount()
  // the next turn rewrites the prefix and the loop resumes
  await $.turn.complete(turn())
  await advance(clock, 5 * MIN)
  expect(w.forks.length).toBe(1)
})

test('/cachettl 1h moves the ping out to 50 minutes and persists', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, [warm, warm])
  await $.session.start(session)
  const r = await $.command.run(run('cachettl', '1h'))
  expect(r.text).toMatch(/cache lifetime 1h/)
  expect(w.store.get('toolbox-cache-ttl')).toBe(HOUR)
  await $.turn.complete(turn())
  await advance(clock, 49 * MIN)
  expect(w.forks.length).toBe(0)
  await advance(clock, 1 * MIN)
  expect(w.forks.length).toBe(1)
})

test('/cachettl defaults to 5m, pinging 4m30s after a turn', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, [warm])
  await $.session.start(session)
  await $.turn.complete(turn())
  await advance(clock, 4 * MIN)
  expect(w.forks.length).toBe(0)
  await advance(clock, 1 * MIN)
  expect(w.forks.length).toBe(1)
})

test('the guard drops a cold send once with the price, then the resend goes through', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, [])
  await $.session.start(session)
  await $.turn.complete(turn())
  await advance(clock, HOUR)
  const first = await $.prompt.submit(prompt('hi'))
  expect(first.drop).toMatch(/toolbox: the prompt cache went cold/)
  expect(first.drop).toMatch(/re-writes up to 200,000 tokens at \$4\/MTok = \$0\.80/)
  expect(w.entered).toEqual([])
  const second = await $.prompt.submit(prompt('hi'))
  expect(second.drop).toBe(undefined)
  expect(w.entered).toEqual(['hi'])
})

test('the guard ignores slash commands and small contexts', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, [], { ctx: 20_000 })
  await $.session.start(session)
  await $.turn.complete(turn())
  await advance(clock, HOUR)
  await $.prompt.submit(prompt('/clear'))
  await $.prompt.submit(prompt('small one'))
  expect(w.entered).toEqual(['/clear', 'small one'])
})

test('warn mode shows the price and sends; off skips the check', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  const w = world(on, [])
  await $.session.start(session)
  await $.command.run(run('cacheguard', 'warn'))
  await $.turn.complete(turn())
  await advance(clock, HOUR)
  await $.prompt.submit(prompt('hi'))
  expect(w.entered).toEqual(['hi'])
  expect(w.logs.at(-1)).toMatch(/Sending anyway/)

  await $.command.run(run('cacheguard', 'off'))
  await advance(clock, HOUR)
  await $.prompt.submit(prompt('bye'))
  expect(w.entered).toEqual(['hi', 'bye'])
})

// ── Pane buttons: the same effect as /cachettl and /cacheguard ──

async function mountPane($: any) {
  return $.ui.mount({ plugin: 'toolbox', surface: 'terminal', component: 'Pane', requestId: 'toolbox', props: paneProps })
}

test('the ttl button flips 5m <-> 1h and persists, like /cachettl', async ($, on) => {
  mock.clock(on, { now: START })
  const w = world(on, [])
  await $.session.start(session)
  const ui = await mountPane($)
  expect(await ui.find({ text: 'ttl 5m' })).toBeDefined()
  await ui.press({ key: 'ttl' })
  expect(w.store.get('toolbox-cache-ttl')).toBe(TTL_1H)
  expect(await ui.find({ text: 'ttl 1h' })).toBeDefined()
  await ui.press({ key: 'ttl' })
  expect(w.store.get('toolbox-cache-ttl')).toBe(TTL_5M)
  expect(await ui.find({ text: 'ttl 5m' })).toBeDefined()
  await ui.unmount()
})

test('the guard button cycles refuse -> warn -> off and persists, like /cacheguard', async ($, on) => {
  mock.clock(on, { now: START })
  const w = world(on, [])
  await $.session.start(session)
  const ui = await mountPane($)
  expect(await ui.find({ text: 'guard block' })).toBeDefined()
  await ui.press({ key: 'guard' })
  expect(w.store.get('toolbox-cache-guard')).toBe('warn')
  expect(await ui.find({ text: 'guard warn' })).toBeDefined()
  await ui.press({ key: 'guard' })
  expect(w.store.get('toolbox-cache-guard')).toBe('off')
  expect(await ui.find({ text: 'guard off' })).toBeDefined()
  await ui.press({ key: 'guard' })
  expect(w.store.get('toolbox-cache-guard')).toBe('refuse')
  expect(await ui.find({ text: 'guard block' })).toBeDefined()
  await ui.unmount()
})

test('the buttons and the slash commands share one state', async ($, on) => {
  mock.clock(on, { now: START })
  const w = world(on, [])
  await $.session.start(session)
  const ui = await mountPane($)
  // the button moves the state the command reports
  await ui.press({ key: 'ttl' })
  expect((await $.command.run(run('cachettl', 'status'))).text).toMatch(/cache lifetime 1h/)
  // the command moves the state the button shows
  await $.command.run(run('cacheguard', 'warn'))
  expect(await ui.find({ text: 'guard warn' })).toBeDefined()
  await ui.unmount()
})
