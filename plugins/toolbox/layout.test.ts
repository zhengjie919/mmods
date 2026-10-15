import { test, expect } from 'claude-code/testing'

import { cellWidth } from './hooks/format'

// Pane width in cells from which the toolbox splits into two columns, and the gap between them. Kept in
// step with pane.tsx, so the test sizes the CACHE column the way the pane does.
const WIDE_AT = 64
const COL_GAP = 3
const colW = (w: number) => (w < WIDE_AT ? w : Math.floor((w - COL_GAP) / 2))

// The widths the pane is drawn at: too narrow for two boxes, the 33/34 split, the default 34, the split
// point 64, and wide. The CACHE grid is two columns when two fit with the gutter, one otherwise.
const WIDTHS = [20, 24, 30, 33, 34, 40, 50, 63, 64, 90, 120]
const COLUMNS: Record<number, number> = { 20: 1, 24: 1, 30: 1, 33: 2, 34: 2, 40: 2, 50: 2, 63: 2, 64: 1, 90: 2, 120: 2 }
const KEYS = ['ping', 'pause', 'ttl', 'guard']
const LABELS = ['ping now', 'pause', 'ttl 5m', 'guard block']

// The text an element shows, as the terminal paints it: a plain Button draws "h: label" for its hotkey.
function flatText(n: any): string {
  if (n === null || n === undefined || typeof n === 'boolean') return ''
  if (typeof n === 'string') return n
  if (typeof n === 'number') return String(n)
  if (n.type === 'Text') return (n.children ?? []).map(flatText).join('')
  if (n.type === 'Button') {
    const kids = (n.children ?? []) as any[]
    const body = kids.length > 0 ? kids.map(flatText).join('') : String(n.props?.label ?? '')
    return n.props?.hotkey === undefined ? body : `${n.props.hotkey}: ${body}`
  }
  return (n.children ?? []).map(flatText).join('')
}

const pad = (s: string, w: number) => (cellWidth(s) >= w ? s : s + ' '.repeat(w - cellWidth(s)))

// A small Ink-like layout, enough for the pane's tree: a row sits side by side, a column stacks, and a
// rounded border wraps a block. It measures in cells, so a wide glyph (⚡) counts for two.
function renderLines(n: any): string[] {
  if (n === null || n === undefined || typeof n === 'boolean') return []
  if (typeof n === 'string' || typeof n === 'number') return [String(n)]
  if (n.type === 'Text' || n.type === 'Button') return [flatText(n)]
  const p = n.props ?? {}
  if (p.display === 'none') return []
  const kids = (n.children ?? []) as any[]
  let lines: string[]
  if (p.flexDirection === 'column' || p.flexDirection === 'column-reverse') {
    lines = kids.flatMap(renderLines)
  } else {
    const blocks = kids.map(renderLines)
    const widths = blocks.map(b => Math.max(0, ...b.map(cellWidth)))
    const h = Math.max(0, ...blocks.map(b => b.length))
    lines = Array.from({ length: h }, (_, i) => blocks.map((b, bi) => pad(b[i] ?? '', widths[bi])).join(''))
  }
  const px = typeof p.paddingX === 'number' ? p.paddingX : 0
  if (px > 0) lines = lines.map(l => ' '.repeat(px) + l + ' '.repeat(px))
  if (typeof p.borderStyle === 'string' && p.borderStyle !== '') {
    const w = Math.max(0, ...lines.map(cellWidth))
    lines = [`╭${'─'.repeat(w)}╮`, ...lines.map(l => `│${pad(l, w)}│`), `╰${'─'.repeat(w)}╯`]
  }
  return lines
}

// The CACHE section: the Box whose direct child is the "⚡ CACHE" header.
function cacheSection(n: any): any {
  const kids = (n?.children ?? []) as any[]
  for (const k of kids) if (k?.type === 'Box' && flatText(k) === '⚡ CACHE') return n
  for (const k of kids) {
    const f = cacheSection(k)
    if (f !== undefined) return f
  }
  return undefined
}

function base(on: any) {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 1, cost: { usd: 0 }, context: { percent: 10, tokens: 1000, window: 1_000_000 } } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('model.fork', () => ({ value: null }))
}

const mountPane = ($: any, bodyColumns: number) =>
  $.ui.mount({
    plugin: 'toolbox',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'toolbox',
    props: { bodyColumns, isFocused: true, title: 'Toolbox' },
  })

test('the cache grid stays inside the column at every width', async ($, on) => {
  base(on)
  for (const w of WIDTHS) {
    const cw = colW(w)
    const ui = await mountPane($, w)
    for (const k of KEYS) expect(await ui.find({ key: k })).toBeDefined()
    const cache = cacheSection(await ui.drawn())
    expect(cache).toBeDefined()
    const ls = renderLines(cache)
    // No line runs past the column the CACHE section is drawn in.
    for (const l of ls) expect(cellWidth(l)).toBeLessThanOrEqual(cw)
    for (const l of ls) console.log(`LAYOUT|${w}|${l}`)
    // The first row holds the first boxes that fit; the rest wrap to the next row.
    const firstRow = ls.find(l => l.includes('ping now'))
    expect(firstRow).toBeDefined()
    const cols = COLUMNS[w]
    expect(LABELS.filter(l => firstRow!.includes(l)).length).toBe(cols)
    // Every grid row is full: no ragged last row (never 3+1), and a one-cell gutter between boxes.
    const tops = ls.filter(l => l.includes('╭'))
    expect(tops.length).toBe(cols === 2 ? 2 : 4)
    for (const t of tops) expect((t.match(/╭/g) ?? []).length).toBe(cols)
    if (cols === 2) for (const t of tops) expect(t).toContain('╮ ╭')
    else for (const t of tops) expect(t).not.toContain('╮ ╭')
    await ui.unmount()
  }
})

test('every cache button is present and pressable', async ($, on) => {
  base(on)
  const ui = await mountPane($, 34)
  for (const k of KEYS) {
    expect(await ui.find({ key: k })).toBeDefined()
    await ui.press({ key: k })
    expect(await ui.find({ key: k })).toBeDefined()
  }
  await ui.unmount()
})
