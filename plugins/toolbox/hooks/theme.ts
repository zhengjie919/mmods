// Colors and the animated bar. Pure: nothing here reads or writes the mod's state.

export type Rgb = [number, number, number]

export const BAR_CELLS = 10
export const WAVE_MS = 2_400

const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0')

// ── Galaxy: the mod's main theme, indigo -> violet -> pink -> cyan ──────────────────────────
export const GALAXY: Rgb[] = [
  [99, 102, 241],
  [167, 139, 250],
  [240, 171, 252],
  [103, 232, 249],
]
const EMPTY_RGB: Rgb = [88, 88, 130]

export function rampAt(stops: Rgb[], x: number): Rgb {
  const f = Math.min(Math.max(x, 0), 1) * (stops.length - 1)
  const i = Math.min(Math.floor(f), stops.length - 2)
  const t = f - i
  return [0, 1, 2].map(c => stops[i][c] + (stops[i + 1][c] - stops[i][c]) * t) as Rgb
}

export function galaxyHex(x: number): string {
  const [r, g, b] = rampAt(GALAXY, x)
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

// Galaxy blended 40% toward white, for the cache buttons: the same hues, paler.
export function galaxyLightHex(x: number): string {
  const [r, g, b] = rampAt(GALAXY, x)
  const lift = (c: number) => c + (255 - c) * 0.4
  return `#${hex(lift(r))}${hex(lift(g))}${hex(lift(b))}`
}

// Plasma for the handoff buttons; the dark purple middle of the real map is lifted so every button stays readable on a dark terminal.
const PLASMA: Rgb[] = [
  [129, 140, 255],
  [196, 102, 230],
  [236, 98, 150],
  [250, 160, 80],
  [245, 235, 70],
]

export function plasmaHex(x: number): string {
  const [r, g, b] = rampAt(PLASMA, x)
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

function shade([r, g, b]: Rgb, k: number): string {
  return `#${hex(r * k)}${hex(g * k)}${hex(b * k)}`
}

// ── Bars ────────────────────────────────────────────────────────────────────────────────────
// The context bar glows along matplotlib's magma: deep purple, magenta, coral, peach, cream.
export const MAGMA: Rgb[] = [
  [135, 60, 190],
  [185, 60, 150],
  [235, 90, 110],
  [254, 159, 109],
  [252, 253, 191],
]

// Each cell takes its galaxy gradient color and breathes on a sine wave offset by its index,
// so a soft glow travels along the bar.
export function barCells(
  pct: number,
  now: number,
  n = BAR_CELLS,
  stops: Rgb[] = GALAXY,
  period = WAVE_MS,
): { ch: string; color: string }[] {
  const filled = Math.round((pct / 100) * n)
  const phase = (now % period) / period
  return Array.from({ length: n }, (_, i) => {
    if (i >= filled) return { ch: '░', color: shade(EMPTY_RGB, 1) }
    const wave = 0.5 + 0.5 * Math.sin(2 * Math.PI * (phase - i / n))
    return { ch: '█', color: shade(rampAt(stops, i / Math.max(1, n - 1)), 0.6 + 0.4 * wave) }
  })
}

// The context bar split by category: one run of cells per part, sized by its share of `max` (at
// least one cell for any part that holds tokens), coloured along `stops` from the first part to
// the last. Cells past the parts are empty. The same glow as barCells travels along the bar.
export function partColor(i: number, count: number, stops: Rgb[] = MAGMA): string {
  const [r, g, b] = rampAt(stops, count <= 1 ? 0.5 : i / (count - 1))
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

export function segCells(
  tokens: number[],
  max: number,
  now: number,
  n: number,
  stops: Rgb[] = MAGMA,
  period = WAVE_MS,
): { ch: string; color: string }[] {
  const sizes = tokens.map(t => (t > 0 && max > 0 ? Math.max(1, Math.round((t / max) * n)) : 0))
  for (let over = sizes.reduce((a, b) => a + b, 0) - n; over > 0; over--) {
    sizes[sizes.indexOf(Math.max(...sizes))] -= 1
  }
  const phase = (now % period) / period
  const cells: { ch: string; color: string }[] = []
  sizes.forEach((size, p) => {
    const [r, g, b] = rampAt(stops, tokens.length <= 1 ? 0.5 : p / (tokens.length - 1))
    for (let c = 0; c < size; c++) {
      const wave = 0.5 + 0.5 * Math.sin(2 * Math.PI * (phase - cells.length / n))
      cells.push({ ch: '█', color: shade([r, g, b], 0.6 + 0.4 * wave) })
    }
  })
  while (cells.length < n) cells.push({ ch: '░', color: shade(EMPTY_RGB, 1) })
  return cells
}

// ── Status colors ───────────────────────────────────────────────────────────────────────────
export function hitColor(pct: number): string {
  return pct >= 80 ? '#a78bfa' : pct >= 50 ? '#f0abfc' : '#fb7185'
}

export function leftColor(sec: number): string {
  return sec > 120 ? '#67e8f9' : sec > 60 ? '#f0abfc' : '#fb7185'
}

export function ctxColor(pct: number): string {
  const [r, g, b] = rampAt(MAGMA, 0.35 + 0.65 * (Math.min(Math.max(pct, 0), 100) / 100))
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

// ── Tool call lines ─────────────────────────────────────────────────────────────────────────
export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch']
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const RUN_TOOLS = ['Bash', 'Agent', 'Task', 'Skill', 'Workflow']

// Settled tool calls: the text fades from a deeper tone to light, like the other ramps, green for success, rose for failure.
const OK_FADE: Rgb[] = [[74, 222, 128], [187, 247, 208]]
const BAD_FADE: Rgb[] = [[251, 113, 133], [254, 205, 211]]
export const statusHex = (ok: boolean, x: number): string => {
  const [r, g, b] = rampAt(ok ? OK_FADE : BAD_FADE, x)
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

// Cool for looking, warm pink for changing files, violet for running things, indigo for the rest.
export function toolColor(tool: string): string {
  if (READ_TOOLS.includes(tool)) return '#67e8f9'
  if (WRITE_TOOLS.includes(tool)) return '#f0abfc'
  if (RUN_TOOLS.includes(tool)) return '#a78bfa'
  return '#818cf8'
}

// ── Your messages: blue ─────────────────────────────────────────────────────────────────────
// A bar down the left edge cycling sky to royal blue, over a background that fades from navy
// on the left to a brighter blue on the right.
export const USER_BARS = ['#38bdf8', '#3b82f6', '#2563eb', '#3b82f6']
const USER_FADE: Rgb[] = [[15, 23, 62], [23, 37, 110], [30, 64, 175]]
export const USER_WIDTH = 100
export const USER_MIN = 40

export const blueAt = (x: number): string => {
  const [r, g, b] = rampAt(USER_FADE, x)
  return `#${hex(r)}${hex(g)}${hex(b)}`
}
