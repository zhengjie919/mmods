// Plasma-gradient boxes, shared by the band above the prompt and the pane. Border and label are
// drawn cell by cell so one gradient runs left to right across everything measured by `total`.
import { plasmaHex } from './theme'
import { type Btn, pack } from './format'

export type Ui = { Box: any; Button: any; Text: any }

export function gradient(ui: Ui, total: number, hexAt: (x: number) => string = plasmaHex) {
  const { Box, Button, Text } = ui
  const col = (x: number) => hexAt(x / Math.max(1, total - 1))
  const paint = (str: string, x0: number, key: string) =>
    [...str].map((ch, i) => (
      <Text key={`${key}${i}`} color={col(x0 + i)} bold>{ch}</Text>
    ))
  // A rounded box `inner` cells wide around `body`, its left edge at gradient position x0.
  const frame = (id: string, inner: number, x0: number, body: unknown) => (
    <Box key={id} flexDirection="column">
      <Box>{paint(`╭${'─'.repeat(inner)}╮`, x0, 't')}</Box>
      <Box>
        {paint('│', x0, 'l')}
        {body}
        {paint('│', x0 + inner + 1, 'r')}
      </Box>
      <Box>{paint(`╰${'─'.repeat(inner)}╯`, x0, 'u')}</Box>
    </Box>
  )
  // A button with a hotkey is drawn "h: label": the three cells of "h: " widen the box.
  const boxBtn = (id: string, label: string, x0: number, onPress: () => void, hotkey?: string) =>
    frame(id, label.length + 2 + (hotkey === undefined ? 0 : 3), x0, (
      <Button label={label} onPress={onPress} hotkey={hotkey} plain>
        {paint(` ${label} `, x0 + 1, 'b')}
      </Button>
    ))
  return { paint, frame, boxBtn }
}

// The column count for a grid: the largest count that fills every row (divides the item count) and fits
// the column, capped at two so a small button set reads as a block; one when two do not fit.
function gridCols(count: number, fit: number): number {
  for (let c = Math.min(fit, 2); c > 1; c--) if (count % c === 0) return c
  return 1
}

// A grid of buttons: every box shares one inner width (the widest label, padded), so the boxes line up
// in columns, one cell apart. The column count fills every row and fits the column (see gridCols); a
// label too wide for the cell is cut with an ellipsis, so no box crosses colW. The gradient is measured
// over the widest row, as gradBtns.
export function gradGrid(ui: Ui, items: Btn[], colW: number, hexAt?: (x: number) => string) {
  const { Box, Button, Text } = ui
  const keyW = items.some(b => b.hotkey !== undefined) ? 3 : 0
  const widest = Math.max(1, ...items.map(b => b.label.length))
  const inner = Math.max(1, Math.min(widest + keyW, colW - 2))
  const labelW = Math.max(1, inner - keyW)
  const cell = inner + 2
  // A row of n boxes takes n cells and n-1 one-cell gutters.
  const fit = Math.max(1, Math.floor((colW + 1) / (cell + 1)))
  const cols = gridCols(items.length, fit)
  const rows: Btn[][] = []
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols))
  const rowW = (n: number) => n * cell + Math.max(0, n - 1)
  const total = Math.max(...rows.map(r => rowW(r.length))) - 1
  const { paint, frame } = gradient(ui, total, hexAt)
  const fitLabel = (label: string) =>
    label.length > labelW ? `${label.slice(0, Math.max(1, labelW - 1))}…` : label.padEnd(labelW)
  // One blank cell on each of the box's three lines, so the gutter runs the full height.
  const gutter = (key: string) => (
    <Box key={key} flexDirection="column">
      <Text>{' '}</Text>
      <Text>{' '}</Text>
      <Text>{' '}</Text>
    </Box>
  )
  return (
    <Box flexDirection="column">
      {rows.map((r, ri) => (
        <Box key={ri}>
          {r.map((b, bi) => (
            <Box key={b.id} flexDirection="row">
              {bi > 0 ? gutter(`g${ri}-${bi}`) : null}
              {frame(b.id, inner, bi * (cell + 1), (
                <Button key={b.id} label={b.label} onPress={b.onPress} hotkey={b.hotkey} plain>
                  {paint(fitLabel(b.label), bi * (cell + 1) + 1, 'b')}
                </Button>
              ))}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}

// A set of buttons, each in its own box. Rows wrap before the column's edge by `pack`; the gradient
// is measured over the widest row, so a wrapped row restarts at the left colour.
export function gradBtns(ui: Ui, items: Btn[], colW: number) {
  const { Box, Text } = ui
  const rows = pack(items.map(b => ({ ...b, w: b.label.length + 5 + (b.hotkey === undefined ? 0 : 3) })), colW)
  const total = Math.max(...rows.map(r => r.reduce((a, b) => a + b.w, 0))) - 1
  const { boxBtn } = gradient(ui, total)
  return (
    <Box flexDirection="column">
      {rows.map((r, ri) => {
        const starts = r.map((_, bi) => r.slice(0, bi).reduce((a, b) => a + b.w, 0))
        return (
          <Box key={ri}>
            {r.map((b, bi) => (
              <Box key={b.id}>
                {boxBtn(b.id, b.label, starts[bi], b.onPress, b.hotkey)}
                <Text>{' '}</Text>
              </Box>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}
