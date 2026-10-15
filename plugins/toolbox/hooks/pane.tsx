// The toolbox pane: sections of stats and buttons, one column when narrow and two when wide.
import { gradGrid, type Ui } from './gradient'
import { type Btn, clock, dur, pack, pickLabel, sparkline, usd } from './format'
import { mcpView } from './mcp'
import { idlePingCap, s, TTL_1H } from './state'
import { barCells, ctxColor, galaxyHex, galaxyLightHex, hitColor, leftColor, MAGMA, partColor, segCells, WAVE_MS } from './theme'

const SECTIONS = 7
// Pane width in cells from which the toolbox splits into two columns, and the gap between them.
const WIDE_AT = 64
const COL_GAP = 3
// The handoff labels are padded to the widest wording, so the boxes keep one size while a label changes.
const HAND_W = '⇄ handoff + pickup'.length

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'].map(v => ({ value: v }))

// What the buttons do, handed in by the hooks module: this file never touches the engine.
export type PaneActions = {
  ping: () => void
  togglePause: () => void
  toggleTtl: () => void
  cycleGuard: () => void
  setModel: (value: string) => void
  setEffort: (value: string) => void
  handoff: () => void
  listHandoffs: () => void
  flow: () => void
  newChat: () => void
  pickupFrom: (path: string) => void
  setTab: (tab: 'main' | 'mcp') => void
  refreshMcp: () => void
  openMcp: () => void
  authMcp: (server: string) => void
}

// One model button: the value is what /model receives, taken from settings.json (modelPicker), never typed here.
export type ModelOption = { value: string; label: string }

export type PaneData = {
  now: number
  leftSec: number
  currentModel: string
  models: ModelOption[]
  bodyColumns?: number
  act: PaneActions
}

export function paneView({ Box, Button, Text }: Ui, d: PaneData) {
  const tabs = (
    <Box>
      {(['main', 'mcp'] as const).map(t => (
        <Box key={t}>
          <Button label={t} onPress={() => d.act.setTab(t)} plain>
            <Text color={s.tab === t ? '#a78bfa' : '#6b7280'} bold={s.tab === t} underline={s.tab === t}>{` ${t === 'main' ? 'toolbox' : 'mcp'} `}</Text>
          </Button>
          <Text>{' '}</Text>
        </Box>
      ))}
    </Box>
  )
  if (s.tab === 'mcp') {
    return (
      <Box flexDirection="column">
        {tabs}
        <Text>{' '}</Text>
        {mcpView({ Box, Button, Text }, d.bodyColumns ?? 34, d.act)}
      </Box>
    )
  }
  const { now, leftSec, currentModel, models, act } = d
  const modelValue = models.find(m => m.value === currentModel || currentModel.includes(m.value))?.value
  // Layout follows the pane's width: one column when narrow, two side by side when wide.
  // Every bar and button row is sized from the column width, so nothing runs past the edge.
  const W = d.bodyColumns ?? 34
  const isWide = W >= WIDE_AT
  const colW = isWide ? Math.floor((W - COL_GAP) / 2) : W
  const barN = Math.max(8, Math.min(30, colW - 9))
  const pct = s.hitRate ?? 0
  const cells = barCells(pct, now, barN)
  // A slower period than the cache bar, so the two glows drift out of step.
  const ctxCells = barCells(s.contextPct ?? 0, now, barN, MAGMA, WAVE_MS * 1.5)
  const chars = [...sparkline(s.turnCosts)]
  const avg = s.turnCosts.length ? s.turnCosts.reduce((a, b) => a + b, 0) / s.turnCosts.length : 0
  const peak = s.turnCosts.length ? Math.max(...s.turnCosts) : 0
  const avgTurn = s.turnMs.length ? s.turnMs.reduce((a, b) => a + b, 0) / s.turnMs.length : 0
  const isRunning = s.turnStartAt !== 0
  const ctx = s.contextPct ?? 0
  const k = (n: number) => `${Math.round(n / 1000)}k`
  // Headers share one gradient down the pane: each section takes the next slice of the galaxy
  // colors, and every letter within a slice shifts a little, so no two headers match.
  // The slot is the section's place in the display order, top to bottom.
  const head = (t: string, n: number) => {
    return (
      <Box>
        {[...t].map((ch, i) => (
          <Text key={i} color={galaxyHex((n + i / Math.max(1, t.length - 1)) / SECTIONS)} bold>{ch}</Text>
        ))}
      </Box>
    )
  }
  const gap = <Text>{' '}</Text>
  // Each button is a rectangle: a rounded border (2 cells) around one padded label (2 cells).
  // Boxes fill each row left to right and wrap to the next row before the column's edge.
  const btns = (items: Btn[]) =>
    pack(items.map(b => ({ ...b, w: b.label.length + 5 + (b.hotkey === undefined ? 0 : 3) })), colW).map((r, ri) => (
      <Box key={ri}>
        {r.map(b => (
          <Box key={b.id}>
            <Box borderStyle="round" borderColor={b.color ?? (b.primary ? '#a78bfa' : '#6b7280')} paddingX={1}>
              <Button key={b.id} label={b.label} onPress={b.onPress} hotkey={b.hotkey} plain>
                <Text color={b.color} bold={b.color !== undefined || b.primary === true}>{b.label}</Text>
              </Button>
            </Box>
            <Text>{' '}</Text>
          </Box>
        ))}
      </Box>
    ))
  // A choice drawn as a grid without boxes: every cell is 8 cells wide (a dot or blank, the label padded
  // to 6, one space), so the model and effort rows line up. The current one gets the dot and an underline.
  const CELL = 8
  const seg = (items: { id: string; label: string; color: string; isCurrent: boolean; onPress: () => void }[]) => {
    const perRow = Math.max(1, Math.floor(colW / CELL))
    const rows: (typeof items)[] = []
    for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow))
    return rows.map((r, ri) => (
      <Box key={ri}>
        {r.map(b => (
          <Box key={b.id}>
            <Button key={b.id} label={b.label} onPress={b.onPress} plain>
              <Text color={b.color} bold={b.isCurrent} underline={b.isCurrent}>
                {`${b.isCurrent ? '●' : ' '}${b.label}`}
              </Text>
              <Text>{' '.repeat(CELL - 1 - b.label.length)}</Text>
            </Button>
          </Box>
        ))}
      </Box>
    ))
  }
  const row = (label: string, v: string, color?: string) => (
    <Box>
      <Text dimColor>{label.padEnd(9)}</Text>
      <Text color={color}>{v}</Text>
    </Box>
  )

  // The idle loop's ping count, or why it stopped (in place of the count) until the next turn.
  const cap = idlePingCap(s.cacheTtlMs)
  const stopRoom = Math.max(6, colW - 11)
  const stopText = s.pingStop === undefined
    ? undefined
    : `⏹ ${s.pingStop.length > stopRoom ? `${s.pingStop.slice(0, stopRoom - 1)}…` : s.pingStop}`
  const cache = (
    <Box flexDirection="column">
      {head('⚡ CACHE', 3)}
      <Box>
        {cells.map((c, i) => (
          <Text key={i} color={c.color}>{c.ch}</Text>
        ))}
        <Text color={hitColor(pct)} bold>{` ${pct}%`}</Text>
      </Box>
      {row('ttl', s.warmUntil === 0 ? 'waiting' : s.pingStop !== undefined || leftSec === 0 ? '❄ cold' : `♨ ${clock(leftSec)}`, s.pingStop !== undefined || (s.warmUntil !== 0 && leftSec === 0) ? '#fb7185' : leftColor(leftSec))}
      {row('pings', stopText ?? (s.isPaused ? `${s.idlePings}/${cap}  ⏸ paused` : `${s.idlePings}/${cap}`), stopText !== undefined ? '#fb7185' : s.isPaused ? '#f0abfc' : undefined)}
      {gradGrid({ Box, Button, Text }, [
        // The two dynamic labels keep their widest wording, so the grid does not jump when pressed.
        { id: 'ping', label: 'ping now', hotkey: 'p', onPress: () => act.ping() },
        { id: 'pause', label: (s.isPaused ? 'resume' : 'pause').padEnd('resume'.length), hotkey: 's', onPress: () => act.togglePause() },
        { id: 'ttl', label: s.cacheTtlMs >= TTL_1H ? 'ttl 1h' : 'ttl 5m', hotkey: 't', onPress: () => act.toggleTtl() },
        { id: 'guard', label: (s.guardMode === 'refuse' ? 'guard block' : `guard ${s.guardMode}`).padEnd('guard block'.length), hotkey: 'g', onPress: () => act.cycleGuard() },
      ], colW, galaxyLightHex)}
    </Box>
  )

  // The window by category (see refreshBreakdown): one bar split into runs, then a line per category.
  // The biggest categories get a line; the rest are summed into "other".
  const kk = (n: number) => (n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`)
  const bd = s.breakdown
  const bdParts = bd?.parts ?? []
  const bdCells = bd ? segCells(bdParts.map(p => p.tokens), bd.max, now, barN, MAGMA, WAVE_MS * 1.5) : []
  const bdShown = bd ? [...bdParts.keys()].sort((x, y) => bdParts[y].tokens - bdParts[x].tokens).slice(0, 5) : []
  const bdOther = bd ? bdParts.filter((_, i) => !bdShown.includes(i)).reduce((a, p) => a + p.tokens, 0) : 0
  const bdPct = (n: number) => (bd && bd.max > 0 ? `${Math.round((100 * n) / bd.max)}%` : '-')
  const nameW = Math.max(8, Math.min(16, colW - 14))
  const bdLine = (key: string, color: string, name: string, n: number) => (
    <Box key={key}>
      <Text color={color}>{'■ '}</Text>
      <Text dimColor>{name.slice(0, nameW).padEnd(nameW)}</Text>
      <Text>{` ${kk(n).padStart(5)} ${bdPct(n).padStart(4)}`}</Text>
    </Box>
  )
  const context = (
    <Box flexDirection="column">
      {head('◔ CONTEXT', 4)}
      {bd !== undefined ? (
        <Box>
          {bdCells.map((c, i) => (
            <Text key={i} color={c.color}>{c.ch}</Text>
          ))}
          <Text color={ctxColor(ctx)} bold>{` ${bd.max > 0 ? Math.round((100 * bd.used) / bd.max) : 0}%`}</Text>
        </Box>
      ) : s.contextPct === undefined ? (
        <Text dimColor>{'no reading yet'}</Text>
      ) : (
        <Box>
          {ctxCells.map((c, i) => (
            <Text key={i} color={c.color}>{c.ch}</Text>
          ))}
          <Text color={ctxColor(ctx)} bold>{` ${ctx}%`}</Text>
        </Box>
      )}
      {bdShown.map(i => bdLine(`bd${i}`, partColor(i, bdParts.length), bdParts[i].name, bdParts[i].tokens))}
      {bdOther > 0 ? bdLine('bd-other', '#6b7280', 'other', bdOther) : null}
      {bd !== undefined ? row('window', `${kk(bd.max)} (${bd.source})`) : null}
      {s.contextTokens !== undefined && s.contextWindow > 0 ? row('tokens', `${k(s.contextTokens)} / ${k(s.contextWindow)}`) : null}
    </Box>
  )

  const time = (
    <Box flexDirection="column">
      {head('⏱ TIME', 5)}
      {row('session', s.sessionStart === 0 ? '-' : dur(now - s.sessionStart), '#67e8f9')}
      {row('turn', isRunning ? `${dur(now - s.turnStartAt)} ▸ running` : s.turnMs.length ? dur(s.turnMs[s.turnMs.length - 1]) : '-')}
      {row('avg turn', s.turnMs.length ? dur(avgTurn) : '-')}
    </Box>
  )

  const cost = (
    <Box flexDirection="column">
      {head('$ COST', 6)}
      <Box>
        {chars.length === 0 ? (
          <Text dimColor>{'no turns yet'}</Text>
        ) : (
          chars.map((ch, i) => (
            <Text key={i} color={galaxyHex(chars.length === 1 ? 0 : i / (chars.length - 1))}>{ch}</Text>
          ))
        )}
      </Box>
      {row('last', usd(s.turnCosts[s.turnCosts.length - 1] ?? 0), '#a78bfa')}
      {row('avg', usd(avg))}
      {row('peak', usd(peak))}
      {row('turns', String(s.turnCosts.length))}
      {row('total', usd(s.lastTotal), '#67e8f9')}
    </Box>
  )

  const model = (
    <Box flexDirection="column">
      {head('⚙ MODEL', 0)}
      {modelValue === undefined ? row('current', currentModel) : null}
      <Text dimColor>{'model   weaker ▸ stronger'}</Text>
      {seg(
        models.map((m, i) => ({
          id: `model-${m.value}`,
          color: galaxyHex(i / Math.max(1, models.length - 1)),
          label: m.label,
          isCurrent: m.value === modelValue,
          onPress: () => act.setModel(m.value),
        })),
      )}
      {gap}
      <Text dimColor>{'effort  lighter ▸ deeper'}</Text>
      {seg(
        EFFORTS.map((x, i) => ({
          id: `effort-${x.value}`,
          color: galaxyHex(i / (EFFORTS.length - 1)),
          label: x.value,
          isCurrent: x.value === s.effort,
          onPress: () => act.setEffort(x.value),
        })),
      )}
    </Box>
  )

  const handoffSection = (
    <Box flexDirection="column">
      {head('✉ HANDOFF', 1)}
      {gradGrid({ Box, Button, Text }, [
        {
          id: 'handoff',
          label: (isRunning ? 'handoff (busy)' : 'handoff').padEnd(HAND_W),
          hotkey: 'h',
          onPress: () => act.handoff(),
        },
        {
          id: 'pickup',
          label: (s.picks === undefined ? 'pickup' : 'pickup ▾').padEnd(HAND_W),
          hotkey: 'u',
          onPress: () => act.listHandoffs(),
        },
        {
          id: 'flow',
          label: (s.isFlowing ? 'flow… (working)' : '⇄ handoff + pickup').padEnd(HAND_W),
          hotkey: 'f',
          onPress: () => act.flow(),
        },
      ], colW)}
      {s.picks === undefined ? null : (
        <Box flexDirection="column">
          <Text dimColor>{'choose one, newest first'}</Text>
          {btns(
            s.picks.map(pk => ({
              id: `pick-${pk.path}`,
              label: pickLabel(pk, colW - 5),
              onPress: () => act.pickupFrom(pk.path),
            })),
          )}
        </Box>
      )}
    </Box>
  )

  // Apart from the handoff buttons: it clears the thread, so it asks for a second press.
  const sessionSection = (
    <Box flexDirection="column">
      {head('◐ SESSION', 2)}
      {btns([
        {
          id: 'newchat',
          label: s.isNewChatArmed ? 'press again to clear' : '+ new chat',
          color: s.isNewChatArmed ? '#fb7185' : undefined,
          onPress: () => act.newChat(),
        },
      ])}
    </Box>
  )

  const spacer = <Text>{' '.repeat(COL_GAP)}</Text>

  if (!isWide) {
    return (
      <Box flexDirection="column">
        {tabs}
        {gap}
        {model}
        {gap}
        {handoffSection}
        {gap}
        {sessionSection}
        {gap}
        {cache}
        {gap}
        {context}
        {gap}
        {time}
        {gap}
        {cost}
      </Box>
    )
  }
  // Wide: controls on the left, status on the right.
  return (
    <Box flexDirection="column">
      {tabs}
      {gap}
      <Box>
      <Box width={colW} flexDirection="column">
        {model}
        {gap}
        {handoffSection}
        {gap}
        {sessionSection}
      </Box>
      {spacer}
      <Box width={colW} flexDirection="column">
        {cache}
        {gap}
        {context}
        {gap}
        {time}
        {gap}
        {cost}
      </Box>
    </Box>
    </Box>
  )
}
