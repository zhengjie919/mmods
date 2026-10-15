import type { Register } from 'claude-code'

import { bandView } from './band'
import { assistantMessageView, toolUseView, userMessageView } from './conversation'
import { dur, rate, usd } from './format'
import { serversFromTools } from './mcp'
import { paneView } from './pane'
import {
  BIG_TOKENS,
  GUARD_KEY,
  idlePingCap,
  MAX_TURNS,
  PANE,
  pingInterval,
  pingMargin,
  s,
  STORE_KEY,
  TICK_MS,
  TTL_1H,
  TTL_5M,
  TTL_KEY,
  VIEW_KEY,
} from './state'

// Everything that takes the engine's `$` lives in this file: the engine follows `$` into functions
// of this file only, never across an import. The other files draw from plain values and callbacks.

// ── Persistence ─────────────────────────────────────────────────────────────────────────────────
// The session's history is tagged with its start time, so a different session never restores it.
async function persist($: any): Promise<void> {
  await $.store.set(STORE_KEY, {
    startedAt: s.sessionStart,
    turnCosts: s.turnCosts,
    turnMs: s.turnMs,
    effort: s.effort,
  })
}

async function restore($: any): Promise<void> {
  const usage = await $.session.usage()
  s.sessionStart = usage.startedAt
  s.lastTotal = usage.cost?.usd ?? 0
  s.contextPct = usage.context.percent
  s.contextTokens = usage.context.tokens
  s.contextWindow = usage.context.window
  const saved = (await $.store.get(STORE_KEY)) as
    | { startedAt: number; turnCosts: number[]; turnMs: number[]; effort?: string }
    | undefined
  if (saved?.startedAt === s.sessionStart) {
    s.turnCosts = saved.turnCosts
    s.turnMs = saved.turnMs
    s.effort = saved.effort
  }
  await refreshBreakdown($)
}

// The window by category, from /context's own breakdown (estimated locally, no API call). Only
// content in the window counts as a part; free space and the compaction buffer are left out.
async function refreshBreakdown($: any): Promise<void> {
  try {
    const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    if (b === undefined) return
    const parts = b.categories
      .filter((c: { kind: string; tokens: number }) => c.kind === 'used' && c.tokens > 0)
      .map((c: { name: string; tokens: number }) => ({ name: c.name, tokens: c.tokens }))
    s.breakdown = {
      parts,
      max: b.rawMaxTokens,
      used: parts.reduce((a: number, p: { tokens: number }) => a + p.tokens, 0),
      source: b.autocompactSource,
    }
  } catch {
    // keep the last good breakdown
  }
}

// ── Cache keep-warm: ping the model before the prompt cache expires ─────────────────────────────
// The ping prompt is a constant, so nothing crafted can be sent through it.
const PING_PROMPT = 'Reply with the single character "." and nothing else.'

// $ per million tokens, [cache read, 1h cache write, output], list prices; longest family first, so a
// model id matches the first row it contains. Taken from cache-tax's table.
const PRICES: [string, number, number, number][] = [
  ['fable-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['opus-5', 0.5, 10, 25],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku', 0.1, 2, 5],
]

function priceOf(model: string | null | undefined): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, read, write, output] of PRICES) if (m.includes(family)) return [read, write, output]
  return null
}

function clearPing(): void {
  s.pingTimer?.cancel()
  s.pingTimer = undefined
}

// A fresh warm epoch: the cache is warm for one lifetime from now, and the next ping is due one margin
// before that. Any stop reason is forgotten, because a turn rewrote the prefix.
async function schedule($: any): Promise<void> {
  clearPing()
  s.pingStop = undefined
  s.warmUntil = (await $.clock.now()) + s.cacheTtlMs
  if (!s.isPaused) s.pingTimer = $.clock.after(pingInterval(s.cacheTtlMs), () => ping($))
}

async function togglePause($: any): Promise<void> {
  s.isPaused = !s.isPaused
  clearPing()
  if (!s.isPaused && s.warmUntil !== 0) {
    const wait = Math.max(0, s.warmUntil - pingMargin(s.cacheTtlMs) - (await $.clock.now()))
    s.pingTimer = $.clock.after(wait, () => ping($))
  }
  $.ui.invalidate('ui.render')
}

// The cache lifetime, shared by /cachettl and the pane's ttl button: set it, remember it, and re-arm
// the current warm epoch at the new interval.
async function setCacheTtl($: any, ttlMs: number): Promise<void> {
  s.cacheTtlMs = ttlMs
  await $.store.set(TTL_KEY, ttlMs)
  if (s.warmUntil !== 0) await schedule($)
  $.ui.invalidate('ui.render')
}

// The cold-send guard mode, shared by /cacheguard and the pane's guard button.
async function setGuardMode($: any, mode: 'refuse' | 'warn' | 'off'): Promise<void> {
  s.guardMode = mode
  await $.store.set(GUARD_KEY, mode)
  $.ui.invalidate('ui.render')
}

// What the guard button cycles through: refuse -> warn -> off -> refuse.
function nextGuard(mode: 'refuse' | 'warn' | 'off'): 'refuse' | 'warn' | 'off' {
  return mode === 'refuse' ? 'warn' : mode === 'warn' ? 'off' : 'refuse'
}

// Why the idle loop must stop after a fork: the engine failed, or the readback shows the prefix was
// already gone. The usage field names are the engine's own.
function forkStopReason(r: any): string | undefined {
  if (r === null || r === undefined) return 'no reply (cold snapshot or API failure)'
  if (r.isAnswered === false) {
    return r.reason === 'nothing-to-fork' ? 'no conversation to warm yet'
      : r.reason === 'api-error' ? `API failed${r.status == null ? '' : ` (${r.status})`}`
      : r.reason === 'aborted' ? 'ping interrupted'
      : 'ping returned no text'
  }
  const u = r.usage
  if (u === undefined) return 'ping reported no usage'
  if (u.cache_read_input_tokens === 0) return 'ping read nothing, cache gone'
  if (u.cache_creation_input_tokens >= 0.1 * u.cache_read_input_tokens) {
    return `ping wrote ${u.cache_creation_input_tokens} of ${u.cache_read_input_tokens} read, cache gone`
  }
  return undefined
}

async function ping($: any, isManual = false): Promise<void> {
  if (s.isPinging) return
  if (!isManual) {
    if (s.isPaused || s.idlePings >= idlePingCap(s.cacheTtlMs)) return
    // A cold cache would be rewritten, not read: do not ping, wait for the next turn.
    if (s.warmUntil !== 0 && (await $.clock.now()) > s.warmUntil) {
      s.pingStop = 'cache went cold, waiting for the next turn'
      $.ui.invalidate('ui.render')
      return
    }
  }
  s.isPinging = true
  try {
    const r = await $.model.fork({ prompt: PING_PROMPT })
    const why = forkStopReason(r)
    if (why !== undefined) {
      if (isManual) $.ui.toast(`ping: ${why}`)
      else s.pingStop = why
      return
    }
    if (!isManual) s.idlePings += 1
    s.hitRate = rate(r.usage)
    await schedule($)
  } finally {
    s.isPinging = false
    $.ui.invalidate('ui.render')
  }
}

// ── Cold-send guard: the message that pays, dropped once with its price ─────────────────────────
// The estimate is the read-only upper bound: the context times the 1h cache-write rate, against what a
// warm turn would have read it for. Unknown model: no figure.
function coldGuardText(tokens: number, model: string, now: number): string {
  const p = priceOf(model)
  const rateText = p ? `$${p[1]}/MTok` : 'the cache-write rate'
  const cold = p ? usd((tokens * p[1]) / 1e6) : 'n/a'
  const warm = p ? usd((tokens * p[0]) / 1e6) : 'n/a'
  return `the prompt cache went cold ${dur(now - s.warmUntil)} ago. Sending this re-writes up to ${tokens.toLocaleString('en-US')} tokens at ${rateText} = ${cold} (a warm turn would have cost ${warm}).`
}

// The drop for a cold send, or undefined to let it through. Only the first non-blank character of the
// text is read, for a slash. A resend at the same epoch (same warmUntil) always goes through.
async function guardColdSend($: any, e: any): Promise<{ drop: string } | undefined> {
  const now = await $.clock.now()
  if (s.warmUntil === 0 || now <= s.warmUntil) return undefined
  const tokens = s.contextTokens ?? 0
  if (tokens < BIG_TOKENS) return undefined
  const text = coldGuardText(tokens, await $.session.model(), now)
  if (s.guardMode === 'warn') {
    $.ui.toast(`${text} Sending anyway.`)
    return undefined
  }
  if (s.guardAckedUntil === s.warmUntil) {
    s.guardAckedUntil = 0
    return undefined
  }
  s.guardAckedUntil = s.warmUntil
  return { drop: `toolbox: ${text} Send it again to pay it, or /clear and start from a note.` }
}

// ── Simple view ─────────────────────────────────────────────────────────────────────────────────
async function toggleView($: any): Promise<void> {
  s.isSimple = !s.isSimple
  await $.store.set(VIEW_KEY, s.isSimple)
  $.ui.invalidate('ui.render')
}

// ── Handoff and pickup ──────────────────────────────────────────────────────────────────────────
// /handoff is a user-only skill, so run it as the slash command; if the engine rejects that,
// send a plain request the model can act on. Only a total failure toasts.
async function handoff($: any): Promise<void> {
  try {
    await $.command.run({ command: 'handoff' })
  } catch {
    try {
      await $.prompt.submit({
        text: 'Write a handoff document for this conversation using the handoff skill (Skill tool, skill "handoff").',
        asUser: true,
      })
    } catch (err2) {
      $.ui.toast(`handoff failed: ${String(err2)}`)
    }
  }
}

// The handoff files found in the temp folder (where the handoff skill writes them), newest first.
// A click on pickup lists them in the pane; the person chooses, so a second session's file is
// never taken by guess. Choosing sends one request asking the agent to read that file.
async function listHandoffs($: any): Promise<void> {
  if (s.picks !== undefined) {
    s.picks = undefined
    $.ui.invalidate('ui.render')
    return
  }
  try {
    const dir = ((await $.env.get('TMPDIR')) as string | undefined) || '/tmp'
    const script =
      'ls -t "$0"/*handoff*.md 2>/dev/null | head -n 6 | while IFS= read -r f; do printf "%s %s\\n" "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")" "$f"; done'
    const r = await $.process.run(['sh', '-c', script, dir])
    const now = await $.clock.now()
    const found = String(r.stdout)
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => {
        const i = l.indexOf(' ')
        return { path: l.slice(i + 1), ageMs: Math.max(0, now - Number(l.slice(0, i)) * 1000) }
      })
    if (found.length === 0) {
      $.ui.toast(`pickup: no handoff file in ${dir}. Run handoff first.`)
      return
    }
    s.picks = found
    $.ui.invalidate('ui.render')
  } catch (err) {
    $.ui.toast(`pickup failed: ${String(err)}`)
  }
}

// The newest handoff file and its modified time (seconds), or undefined when there is none.
async function newestHandoff($: any): Promise<{ path: string; mtime: number } | undefined> {
  const dir = ((await $.env.get('TMPDIR')) as string | undefined) || '/tmp'
  const script =
    'f=$(ls -t "$0"/*handoff*.md 2>/dev/null | head -n 1); [ -n "$f" ] && printf "%s %s\\n" "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")" "$f"'
  const r = await $.process.run(['sh', '-c', script, dir])
  const line = String(r.stdout).trim()
  if (line === '') return undefined
  const i = line.indexOf(' ')
  return { mtime: Number(line.slice(0, i)), path: line.slice(i + 1) }
}

// One click: write a handoff, wait for the file and for the turn to end, open a fresh chat, then
// pick the new file up there. Gives up with a toast after FLOW_WAIT_MS without a new file.
const FLOW_WAIT_MS = 180000
async function flow($: any): Promise<void> {
  if (s.isFlowing) return
  s.isFlowing = true
  $.ui.invalidate('ui.render')
  try {
    const before = (await newestHandoff($))?.mtime ?? 0
    $.ui.toast('flow: writing handoff')
    await handoff($)
    const start = await $.clock.now()
    let fresh: { path: string; mtime: number } | undefined
    for (;;) {
      await $.clock.sleep(1000)
      const f = await newestHandoff($)
      if (f !== undefined && f.mtime > before && s.turnStartAt === 0) {
        fresh = f
        break
      }
      if ((await $.clock.now()) - start > FLOW_WAIT_MS) break
    }
    if (fresh === undefined) {
      $.ui.toast('flow: no new handoff file, stopped')
      return
    }
    await $.command.run({ command: 'clear' })
    await pickupFrom($, fresh.path)
  } catch (err) {
    $.ui.toast(`flow failed: ${String(err)}`)
  } finally {
    s.isFlowing = false
    $.ui.invalidate('ui.render')
  }
}

async function pickupFrom($: any, path: string): Promise<void> {
  s.picks = undefined
  $.ui.invalidate('ui.render')
  try {
    $.ui.toast(`pickup: ${path}`)
    await $.prompt.submit({
      text: `Read the handoff document at ${path}, then continue the work it describes. Call the skills it lists under suggested skills.`,
      asUser: true,
    })
  } catch (err) {
    $.ui.toast(`pickup failed: ${String(err)}`)
  }
}

// ── Toolbox pane: open and close ────────────────────────────────────────────────────────────────
async function toggleToolbox($: any): Promise<boolean> {
  if (s.pane === 'shown') {
    s.pane = 'closed'
    await $.ui.close({ id: PANE })
    return false
  }
  // 'closed' and 'hidden' both open here; no await comes first, so this counts as asked.
  const opened = await $.ui.open({ id: PANE, title: 'Toolbox', focus: true, closeOnEscape: true, rows: 60, columns: 34 })
  s.pane = opened.isPlaced ? 'shown' : 'hidden'
  if (!opened.isPlaced) $.ui.toast(`toolbox: ${opened.reason}`)
  return true
}

// ── MCP tab ─────────────────────────────────────────────────────────────────────────────────────
// No API lists servers, so read them from the tool list: a server that shows tools is connected,
// one that shows only `authenticate` waits for sign-in.
async function refreshMcp($: any): Promise<void> {
  if (s.isMcpBusy) return
  s.isMcpBusy = true
  s.mcpAt = await $.clock.now()
  $.ui.invalidate('ui.render')
  try {
    s.mcp = serversFromTools((await $.tool.list()).map((t: { name: string }) => t.name))
  } catch (err) {
    $.ui.toast(`mcp: ${String(err)}`)
  } finally {
    s.isMcpBusy = false
    $.ui.invalidate('ui.render')
  }
}

// Toggles the /mcp dialog. The dialog is drawn by the host, which gives a mod no way to close it, so
// under Herdr the pane text says whether it is up and `herdr pane send-keys` presses Esc for it.
async function openMcp($: any): Promise<void> {
  try {
    const pane = (await $.env.get('HERDR_PANE_ID')) as string | undefined
    if (pane) {
      const r = await $.process.run(['herdr', 'pane', 'read', pane, '--source', 'visible'])
      // The title alone can sit in the transcript (this file's own text, a chat reply), so also
      // require the dialog's footer in the last lines of the screen, where the dialog ends.
      const lines = String(r.stdout).split('\n').filter(l => l.trim() !== '')
      const isUp = lines.slice(-4).join('\n').includes('Esc to cancel') && lines.join('\n').includes('Manage MCP servers')
      if (isUp) {
        await $.process.run(['herdr', 'pane', 'send-keys', pane, 'esc'])
        return
      }
    }
  } catch {
    // no Herdr here: fall through and open the dialog
  }
  try {
    await $.command.run({ command: 'mcp' })
  } catch {
    $.ui.toast('could not open /mcp here: type /mcp')
  }
}

// Calls the server's own authenticate tool (no permission dialog: `$.mcp.call` is the plugin's own
// call), keeps the sign-in link for the mcp tab and opens it in the browser.
async function authMcp($: any, server: string): Promise<void> {
  try {
    const r = await $.mcp.call(server, 'authenticate')
    const text = (r.content as { type: string; text?: string }[]).map(c => c.text ?? '').join('\n')
    const url = text.match(/https?:\/\/[^\s"'<>)]+/)?.[0]
    if (url === undefined) {
      $.ui.toast(`${server}: ${text.slice(0, 200) || 'no link returned'}`)
      return
    }
    s.authLinks = { ...s.authLinks, [server]: url }
    $.ui.invalidate('ui.render')
    try {
      await $.process.run(['open', url])
    } catch {
      $.ui.toast(`${server}: open the link shown in the mcp tab`)
    }
  } catch (err) {
    $.ui.toast(`${server}: auth failed (${String(err)}). Use open /mcp`)
  }
}

// ── Hooks ───────────────────────────────────────────────────────────────────────────────────────
export const register: Register = on => {
  // ── Start-up and commands ──
  on('session.start', async ($, e, next) => {
    await restore($)
    // a reload keeps the pane up while the module's variables start over
    const up = (await $.ui.panes()).find((p: { id: string }) => p.id === PANE)
    s.pane = up ? (up.isPlaced ? 'shown' : 'hidden') : 'closed'
    s.isSimple = ((await $.store.get(VIEW_KEY)) as boolean | undefined) ?? false
    s.cacheTtlMs = (await $.store.get(TTL_KEY)) === TTL_1H ? TTL_1H : TTL_5M
    const savedGuard = await $.store.get(GUARD_KEY)
    s.guardMode = savedGuard === 'warn' || savedGuard === 'off' ? savedGuard : 'refuse'
    $.ui.status(undefined)
    s.tickTimer?.cancel()
    s.tickTimer = $.clock.every(TICK_MS, () => {
      $.ui.invalidate('ui.render')
    })
    $.command.register({ name: 'toolbox', description: 'Open or close the cache and cost toolbox on the right' })
    $.command.register({ name: 'simple', description: 'Switch the conversation between simple and full view' })
    $.command.register({ name: 'cachettl', description: 'Cache keep-warm lifetime: 5m (default) or 1h, or status' })
    $.command.register({ name: 'cacheguard', description: 'Cold-send guard: warn, refuse (default) or off' })
    return next(e)
  })

  // The person can close the pane by hand, so the tracked state follows every close.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) s.pane = 'closed'
    return next(e)
  })

  on('command.run', { command: 'toolbox' }, async $ => {
    const isUp = await toggleToolbox($)
    return { text: isUp ? 'Toolbox opened.' : 'Toolbox closed.' }
  })

  on('command.run', { command: 'simple' }, async $ => {
    await toggleView($)
    return { text: s.isSimple ? 'Simple view on.' : 'Full view on.' }
  })

  // The cache lifetime: 5m or 1h. Changing it re-arms the current epoch at the new interval.
  on('command.run', { command: 'cachettl' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)[0]
    if (arg === '5m' || arg === '1h') {
      await setCacheTtl($, arg === '1h' ? TTL_1H : TTL_5M)
    } else if (arg !== undefined && arg !== 'status') {
      return { text: '/cachettl takes 5m, 1h, or status' }
    }
    return { text: `cache lifetime ${s.cacheTtlMs >= TTL_1H ? '1h' : '5m'}; pings every ${dur(pingInterval(s.cacheTtlMs))}, up to ${idlePingCap(s.cacheTtlMs)} per idle stretch` }
  })

  // The cold-send guard mode, remembered across sessions.
  on('command.run', { command: 'cacheguard' }, async ($, e) => {
    const mode = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)[0]
    if (mode !== 'warn' && mode !== 'refuse' && mode !== 'off') {
      return { text: `/cacheguard takes warn, refuse or off (now ${s.guardMode})` }
    }
    await setGuardMode($, mode)
    return { text: mode === 'off' ? 'cache guard off: a cold send is not checked'
      : mode === 'warn' ? 'cache guard warn: a cold send goes through with its price shown'
      : 'cache guard refuse: a cold send is dropped once with its price, the resend goes through' }
  })

  // The message that pays for a cold cache. Slash commands and a plugin's own prompts never reach it.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    if (s.guardMode === 'off') return next(e)
    const drop = await guardColdSend($, e)
    return drop ?? next(e)
  })

  // ── Conversation look: your messages, tool calls, simple view ──
  // Your own messages: blue. ctrl+o (isExpanded) and every other sender keep the engine's drawing.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const p = e.props
    if (p.isExpanded || p.origin.kind !== 'composer' || p.text.trim() === '') return next(e)
    return userMessageView($.ui.resolve(e), p)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary || e.props.text.trim() === '') return next(e)
    return assistantMessageView($.ui.resolve(e), e.props)
  })

  // Full view keeps the engine's own drawing of a tool call and its result; simple view shrinks the call to one line.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!s.isSimple) return next(e)
    return toolUseView($.ui.resolve(e), e.props, await $.clock.now())
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!s.isSimple || e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // ── Turn bookkeeping: cost, context, time, cache ──
  on('turn.start', async ($, e, next) => {
    clearPing()
    s.idlePings = 0
    s.turnStartAt = await $.clock.now()
    return next(e)
  })

  // The request carries the effort in force (the session's setting or the model's default):
  // follow it, so the pane marks the real level, not only one picked here
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && typeof e.effort === 'string' && e.effort !== s.effort) {
      s.effort = e.effort
      $.ui.invalidate('ui.render')
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const usage = await $.session.usage()
      const total = usage.cost?.usd ?? 0
      s.contextPct = usage.context.percent
      s.contextTokens = usage.context.tokens
      s.contextWindow = usage.context.window
      await refreshBreakdown($)
      s.sessionStart = usage.startedAt
      if (s.turnStartAt !== 0) s.turnMs = [...s.turnMs, (await $.clock.now()) - s.turnStartAt].slice(-MAX_TURNS)
      s.turnStartAt = 0
      await persist($)
      s.turnCosts = [...s.turnCosts, Math.max(0, total - s.lastTotal)].slice(-MAX_TURNS)
      s.lastTotal = total
    }
    if (e.agentId === undefined && e.usage) {
      s.hitRate = rate(e.usage)
      await schedule($)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // ── Band above the prompt ──
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    return bandView($.ui.resolve(e), await $.clock.now(), () => void toggleToolbox($), () => void toggleView($))
  })

  // ── Toolbox pane ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = await $.clock.now()
    if (s.sessionStart === 0) s.sessionStart = (await $.session.usage()).startedAt
    const leftSec = s.warmUntil === 0 ? 0 : Math.max(0, Math.ceil((s.warmUntil - now) / 1000))
    // These buttons would wait behind a running turn: say so instead of ignoring the press.
    const idleOnly = (run: () => void) => {
      if (s.turnStartAt === 0) run()
      else $.ui.toast('busy: wait for the turn to end')
    }
    // While the MCP tab shows, read the servers again every 5 seconds so a sign-in appears by itself.
    if (s.tab === 'mcp' && !s.isMcpBusy && now - s.mcpAt > 5000) void refreshMcp($)
    return paneView($.ui.resolve(e), {
      now,
      leftSec,
      currentModel: await $.session.model(),
      bodyColumns: e.props.bodyColumns,
      act: {
        ping: () => void ping($, true),
        togglePause: () => void togglePause($),
        toggleTtl: () => void setCacheTtl($, s.cacheTtlMs >= TTL_1H ? TTL_5M : TTL_1H),
        cycleGuard: () => void setGuardMode($, nextGuard(s.guardMode)),
        setModel: value => void $.command.run({ command: 'model', args: value }),
        setEffort: value => {
          s.effort = value
          void persist($)
          void $.command.run({ command: 'effort', args: value })
        },
        handoff: () => idleOnly(() => void handoff($)),
        listHandoffs: () => idleOnly(() => void listHandoffs($)),
        flow: () => idleOnly(() => void flow($)),
        // Same as typing /clear: a fresh thread. The first press arms it, the second (within 4s) runs it.
        newChat: () =>
          idleOnly(() => {
            if (!s.isNewChatArmed) {
              s.isNewChatArmed = true
              $.clock.after(4000, () => {
                s.isNewChatArmed = false
                $.ui.invalidate('ui.render')
              })
              $.ui.invalidate('ui.render')
              return
            }
            s.isNewChatArmed = false
            void $.command.run({ command: 'clear' })
          }),
        pickupFrom: path => void pickupFrom($, path),
        setTab: tab => {
          s.tab = tab
          if (tab === 'mcp') s.mcpAt = 0
          $.ui.invalidate('ui.render')
        },
        refreshMcp: () => void refreshMcp($),
        openMcp: () => void openMcp($),
        authMcp: server => void authMcp($, server),
      },
    })
  })
}
