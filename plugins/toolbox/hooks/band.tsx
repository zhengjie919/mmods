// The band above the prompt: cache stats in one box, then the toolbox and view buttons.
import { clock, cellWidth, usd } from './format'
import { gradient, type Ui } from './gradient'
import { s } from './state'
import { barCells, hitColor, leftColor } from './theme'

export function bandView({ Box, Button, Text }: Ui, now: number, onToolbox: () => void, onView: () => void) {
  const leftSec = Math.max(0, Math.ceil((s.warmUntil - now) / 1000))
  // Every box is drawn cell by cell so one plasma gradient runs left to right across the whole row.
  // Widths are counted with cellWidth, since ⚡ takes two cells.
  const GAP = 2
  // Names the mode in use; pressing it switches to the other one.
  const viewLabel = s.isSimple ? 'view: simple' : 'view: full'
  const toolLabel = '▸ toolbox'
  const cacheLabel = '⚡ cache '
  const pct = s.hitRate ?? 0
  const cells = barCells(pct, now)
  const pctText = ` ${pct}%`
  const isCold = s.pingStop !== undefined || leftSec === 0
  const timeText = isCold ? '❄ cold' : `♨ ${clock(leftSec)}`
  const costText = usd(s.lastTotal)
  const sep = ' │ '
  const statsInner = [cacheLabel, pctText, sep, timeText, sep, costText].reduce((n, t) => n + cellWidth(t), 2 + cells.length)
  const viewInner = viewLabel.length + 2
  const toolInner = toolLabel.length + 2
  const widths = [statsInner + 2, toolInner + 2, viewInner + 2]
  const total = widths.reduce((a, w) => a + w, 0) + GAP * (widths.length - 1)
  const { frame, boxBtn } = gradient({ Box, Button, Text }, total)
  const gap = <Text key="gap">{' '.repeat(GAP)}</Text>
  const stats = frame('stats', statsInner, 0, (
    <Box>
      <Text>{' '}</Text>
      <Text color="claude" bold>{cacheLabel}</Text>
      {cells.map((c, i) => (
        <Text key={i} color={c.color}>{c.ch}</Text>
      ))}
      <Text color={hitColor(pct)} bold>{pctText}</Text>
      <Text dimColor>{sep}</Text>
      {isCold ? (
        <Text color="#fb7185" bold>{timeText}</Text>
      ) : (
        <Text color={leftColor(leftSec)}>{timeText}</Text>
      )}
      <Text dimColor>{sep}</Text>
      <Text color="#67e8f9">{costText}</Text>
      <Text>{' '}</Text>
    </Box>
  ))
  const toolX = widths[0] + GAP
  const viewX = toolX + widths[1] + GAP

  return (
    <Box alignItems="center">
      {stats}
      {gap}
      {boxBtn('toolbox', toolLabel, toolX, onToolbox)}
      {gap}
      {boxBtn('view', viewLabel, viewX, onView)}
    </Box>
  )
}
