// Plain helpers for text, numbers and button rows. Pure.

export type Usage = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export type Btn = { id: string; label: string; onPress: () => void; hotkey?: string; primary?: boolean; color?: string }

const BLOCKS = '▁▂▃▄▅▆▇█'

export function sparkline(values: number[]): string {
  if (values.length === 0) return ''
  const max = Math.max(...values)
  if (max <= 0) return BLOCKS[0].repeat(values.length)
  return values.map(v => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor((v / max) * (BLOCKS.length - 1)))]).join('')
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

export function rate(u: Usage): number | undefined {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return total === 0 ? undefined : Math.round((100 * u.cache_read_input_tokens) / total)
}

export function clock(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

// 12s, 3m05s, 1h02m: the coarsest two units that matter.
export function dur(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`
}

// One short label for a tool call's input: the field a person would name the call by.
export function brief(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  const v = [o.skill, o.command, o.file_path, o.path, o.pattern, o.query, o.url, o.description, o.prompt].find(
    x => typeof x === 'string' && x !== '',
  ) as string | undefined
  if (v === undefined) return ''
  const line = v.split('\n')[0]
  return line.length > 90 ? `${line.slice(0, 89)}…` : line
}

// Greedy row packing: a button's drawn width is its label plus "[ " and " ]" and one space after.
export function pack<T extends { w: number }>(items: T[], width: number): T[][] {
  const rows: T[][] = [[]]
  let used = 0
  for (const it of items) {
    if (used > 0 && used + it.w > width) {
      rows.push([])
      used = 0
    }
    rows[rows.length - 1].push(it)
    used += it.w
  }
  return rows
}

export type Pick = { path: string; ageMs: number }

// "handoff-cache-keepwarm-2026-10-13-b.md" -> "cache-keepwarm-2026-10-13-b", cut to fit the column.
export function pickLabel(p: Pick, room: number): string {
  const base = (p.path.split('/').pop() ?? p.path).replace(/\.md$/, '').replace(/^handoff-?/, '')
  const age = dur(p.ageMs)
  const name = base.length > room - age.length - 1 ? `${base.slice(0, Math.max(1, room - age.length - 2))}…` : base
  return `${age} ${name}`
}

// Terminal cells a string takes. ⚡ is the one wide glyph the mod draws; every other glyph is one cell.
export function cellWidth(str: string): number {
  return [...str].reduce((n, ch) => n + (ch === '⚡' ? 2 : 1), 0)
}
