// The mod's shared state. Module variables reset on every plugin reload, so what must outlive
// a reload is saved to $.store (see persist and restore in register.tsx).
import type { Timer } from 'claude-code'

export const PANE = 'toolbox'
export const STORE_KEY = 'toolbox-history'
export const VIEW_KEY = 'toolbox-simple-view'
export const TICK_MS = 120 // fast tick drives the bar animation; the countdown text still changes once a second
export const MAX_TURNS = 16
export const TTL_5M = 5 * 60_000
export const TTL_1H = 60 * 60_000
export const TTL_KEY = 'toolbox-cache-ttl'
export const GUARD_KEY = 'toolbox-cache-guard'
// The context size from which a cold send is worth guarding (cache-tax uses the same figure).
export const BIG_TOKENS = 50_000
// A ping is due one margin before the cache expires: 30s for a 5m cache, 10m for 1h (cache-tax's 50m
// of its hour). The idle loop is capped by time, not a fixed count: ~30m of coverage for 5m (6 pings),
// ~3h for 1h (3 pings).
export function pingInterval(ttlMs: number): number {
  return ttlMs >= TTL_1H ? ttlMs - 10 * 60_000 : ttlMs - 30_000
}
export function pingMargin(ttlMs: number): number {
  return ttlMs - pingInterval(ttlMs)
}
export function idlePingCap(ttlMs: number): number {
  const coverage = ttlMs >= TTL_1H ? 3 * 60 * 60_000 : 30 * 60_000
  return Math.max(1, Math.floor(coverage / pingInterval(ttlMs)))
}

export const s = {
  // cache
  warmUntil: 0,
  cacheTtlMs: TTL_5M,
  // why the idle ping loop stopped, shown in place of the ping count until the next turn clears it
  pingStop: undefined as string | undefined,
  // cold-send guard: warn, refuse (drop once), or off; the epoch it last dropped is guardAckedUntil
  guardMode: 'refuse' as 'refuse' | 'warn' | 'off',
  guardAckedUntil: 0,
  hitRate: undefined as number | undefined,
  idlePings: 0,
  pingTimer: undefined as Timer | undefined,
  tickTimer: undefined as Timer | undefined,
  isPinging: false,
  isPaused: false,
  // cost: per-turn history for the sparkline
  turnCosts: [] as number[],
  lastTotal: 0,
  // context
  contextPct: undefined as number | undefined,
  contextTokens: undefined as number | undefined,
  contextWindow: 0,
  // the window by category, as /context lists it; refreshed when a turn ends
  breakdown: undefined as
    | { parts: { name: string; tokens: number }[]; max: number; used: number; source: string }
    | undefined,
  // time
  sessionStart: 0,
  turnStartAt: 0,
  turnMs: [] as number[],
  // no getter for the effort level: the last one picked here, undefined until then
  effort: undefined as string | undefined,
  // simple view: tool calls shrink to one line and successful results are hidden. Kept in $.store.
  isSimple: false,
  // the handoff + pickup flow is running
  isFlowing: false,
  // the new chat button was pressed once and waits for a second press (disarms by itself)
  isNewChatArmed: false,
  // handoff files the pickup button found, while the chooser is open
  picks: undefined as { path: string; ageMs: number }[] | undefined,
  // the toolbox pane: closed, open but waiting undrawn (terminal too narrow), or drawn. Tracked here so
  // the press that opens it needs no await first: the engine counts an open as asked only while it is
  // still inside the press.
  pane: 'closed' as 'closed' | 'hidden' | 'shown',
  // pane tab: the toolbox sections, or the MCP servers
  tab: 'main' as 'main' | 'mcp',
  // MCP servers read from the tool list (see refreshMcp); undefined until the first read
  mcp: undefined as { name: string; tools: number; needsAuth: boolean }[] | undefined,
  mcpAt: 0,
  isMcpBusy: false,
  // sign-in links the authenticate tools returned, by server, shown in the mcp tab
  authLinks: {} as Record<string, string>,
}
