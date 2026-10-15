// How your messages and tool calls look. The hooks module decides when to use them.
import { brief } from './format'
import type { Ui } from './gradient'
import { blueAt, SPIN, statusHex, toolColor, USER_BARS, USER_MIN, USER_WIDTH } from './theme'

export function userMessageView({ Box, Text }: Ui, p: any) {
  // Cut long lines so every row is one gradient strip that never wraps.
  const rows: string[] = []
  for (const line of p.text.split('\n')) {
    if (line === '') rows.push('')
    for (let at = 0; at < line.length; at += USER_WIDTH) rows.push(line.slice(at, at + USER_WIDTH))
  }
  const w = Math.min(USER_WIDTH, Math.max(USER_MIN, ...rows.map(r => r.length + 1)))
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Box key={i}>
          <Text color={USER_BARS[i % USER_BARS.length]} backgroundColor={blueAt(0)} bold>{'▌ '}</Text>
          {Array.from(row.padEnd(w)).map((ch, c) => (
            <Text key={c} color="#e0f2fe" backgroundColor={blueAt((c + 2) / (w + 2))}>{ch}</Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

export function toolUseView({ Box, Text }: Ui, p: any, now: number) {
  const bad = p.isErrored
  const cut = p.isInterrupted
  const bar = bad ? '#fb7185' : cut ? '#fbbf24' : toolColor(p.tool)
  const mark = bad ? '✗' : cut ? '⏹' : p.isRunning ? SPIN[Math.floor(now / 100) % SPIN.length] : '✓'
  // A finished call fades one colour strip across tool name and input; the tool-type colour stays on the bullet.
  const settled = !p.isRunning && !cut
  const name: string = p.tool
  const rest = `  ${brief(p.input)} `
  const span = Math.max(1, name.length + rest.length - 1)
  const strip = (str: string, x0: number, bold: boolean) =>
    Array.from(str).map((ch, i) => (
      <Text key={x0 + i} color={statusHex(!bad, (x0 + i) / span)} bold={bold}>{ch}</Text>
    ))
  return (
    <Box>
      <Text color={settled ? toolColor(p.tool) : bar} bold>{bad || cut ? '▌ ' : '● '}</Text>
      {settled ? strip(name, 0, true) : <Text color={toolColor(p.tool)} bold>{name}</Text>}
      {settled ? strip(rest, name.length, false) : <Text dimColor>{rest}</Text>}
      <Text color={bad ? '#fb7185' : cut ? '#fbbf24' : p.isRunning ? '#a78bfa' : '#86efac'}>{mark}</Text>
    </Box>
  )
}

// Replies keep the markdown renderer (tables, fences, links), which takes no per-character colour,
// so the colour is a flat galaxy-violet box behind the whole reply and a bright bullet opening it.
const REPLY_BG = '#000000'
const REPLY_BULLET = '#c4b5fd'

export function assistantMessageView({ Box, Text, Markdown }: Ui & { Markdown: any }, p: any) {
  return (
    <Box backgroundColor={REPLY_BG}>
      <Text color={REPLY_BULLET} backgroundColor={REPLY_BG} bold>{p.isFirstOfReply ? '● ' : '  '}</Text>
      <Box flexGrow={1} flexDirection="column" paddingRight={1} backgroundColor={REPLY_BG}>
        <Markdown text={p.text} />
      </Box>
    </Box>
  )
}
