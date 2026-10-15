import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { SecondBrainBatch, SecondBrainNote, SecondBrainRunning, SecondBrainSave, SecondBrainTurn } from '../types'
import {
  MAX_TURNS, batchText, bashVerdict, clip, clipEnd, clipMiddle, fallbackNotes, isAllowedWrite, isDurable, isHerdrDelegation,
  isLocked, isWriteLockCommand, mergeBatches, parseAcquire, parseResult, readVerdict, recentNotePaths, redact,
  releaseArgs, toolLine, typedTurns, vaultRelative, words,
} from './policy'

const PANE = 'second-brain'
const AGENT = 'second-brain:capture'
const WIKI = 'internship-technical-wiki'
const STALE_MS = 20 * 60_000
const MAX_QUEUE = 3
const MAX_SAVES = 5
// Batches left at a session's end wait here, one file each, until any session claims them.
const DATA_DIR = '/Users/zhengjie.ng/.claude/second-brain'
const CARRY_DIR = `${DATA_DIR}/carry`
const MAX_GATE_ATTEMPTS = 3
const MAX_ANSWER_CHARS = 12_000
// One cap for the gate and the agent, so the gate decides on the text the agent gets.
const MAX_BATCH_CHARS = 60_000
const OPENCODE_DB = '/Users/zhengjie.ng/.local/share/opencode/opencode.db'

const current = atom({ plugin: 'second-brain', key: 'current' } as const, null)
const pending = atom({ plugin: 'second-brain', key: 'pending' } as const, null)
const queue = atom({ plugin: 'second-brain', key: 'queue' } as const, [])
const running = atom({ plugin: 'second-brain', key: 'running' } as const, null)
const saves = atom({ plugin: 'second-brain', key: 'saves' } as const, [])
const paused = atom({ plugin: 'second-brain', key: 'paused' } as const, false)

const GATE_RULES = `You gate a personal knowledge wiki (the user's "second brain" for a software engineering internship).
You read a batch of finished turns between the user and Claude Code. Answer "durable" when the batch holds any reusable knowledge worth keeping: how code or a system behaves, a root cause, a decision and its reason, a workflow or command that worked, tool or config setup, a gotcha, a verified fact about a service, team or process.
Answer "nothing" for small talk, pure planning with no outcome, a question with no answer yet, or work whose result is still unknown.
Also answer "nothing" when the batch is mainly about the second-brain mod itself, its captures or commits, or edits to the wiki: that is work on the capture system, not knowledge to capture.
Answer with one word: durable or nothing.`

const agentPrompt = (vault: string, roots: string[]) => `You are the second-brain capture agent. You update the user's private wiki at ${vault} from a batch of Claude Code turns. The wiki is the user's second memory brain for their internship.

Rules:
1. Read ${vault}/AGENTS.md first and obey it. The "second-brain" policy there authorizes this capture.
2. Follow the preloaded llm-wiki-crystallize skill for finished findings, or llm-wiki-ingest when the batch is better filed as a source. Prefer to improve an existing page over a new one. A no-op is a valid result.
3. Save any reusable knowledge: code behavior, system facts, decisions, workflows, tool setup, gotchas. Never save transcripts, secrets, credentials or diary entries.
4. Mark a claim verified only when you read its source yourself, in this run, with Read or a search. Claude's answers and opencode worker text are claims, not evidence, also when they say "I read X" or "verified". A claim you could not check is an inference or unverified, per the lifecycle rules.
5. The batch lists notes that recent captures changed. Check them against the new turns and correct any that the new turns show are wrong, keeping conflicts visible per the lifecycle rules.
6. Every write goes through the lock helper, with file scope. Bash runs in the vault root. Use this exact form (no $PWD, no ~, no shell operators):
   python3 scripts/write_lock.py --root ${vault} --wiki ${WIKI} --scope files status --path <paths...>
   python3 scripts/write_lock.py --root ${vault} --wiki ${WIKI} --scope files acquire --path <paths...>
   python3 scripts/write_lock.py --root ${vault} --wiki ${WIKI} --scope files release --path <paths...> --owner-id <id>
   List every file you will write (notes, indexes, the daily log) in one acquire. Edit and Write are refused on a path you have not locked. To add a path, release, then acquire the full new set. On a conflict, wait with "sleep 10" and retry, up to 6 times. Always release your lock, also after a failure.
7. Tools: Read only inside ${roots.join(', ')}, never credential files. Edit and Write only inside the vault, never AGENTS.md, CLAUDE.md, schema/, scripts/ or any dot file or dot folder. Bash only: rg, grep (no -r), ls, cat, head, tail, wc, find (no -exec, -delete, -f*), date, pwd, sleep, git status/diff/log/show/ls-files, and the lock helper. File arguments must be inside the read roots. You cannot delete, move or rename files. Do not commit: leave your changes uncommitted for the user to review.
8. Update the relevant index and the daily log as the skills say.

Your final message must end with exactly one line in this form (JSON on one line):
SECOND_BRAIN {"status":"saved"|"nothing","summary":"<one sentence of what changed or why nothing>","notes":[{"path":"<vault-relative path without .md>","title":"<note title>"}]}`

let idle: Timer | undefined
let staleTimer: Timer | undefined
const captureAgents = new Set<string>()

const cfg = {
  vault: '/Users/zhengjie.ng/Documents/internship-technical-wiki',
  vaultReal: '/Users/zhengjie.ng/Documents/internship-technical-wiki',
  readRoots: ['/Users/zhengjie.ng/gopath/src'],
  model: 'haiku',
  batchTurns: 6,
  idleMs: 3 * 60_000,
  isWatching: true,
  cwd: '',
}

function roots(): string[] {
  return [cfg.vaultReal, ...cfg.readRoots]
}

// Resolves paths (relative ones from the vault root) the way the OS opens them: symlinks and `..` gone.
async function realpaths($: EngineInterface, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  const code = "import os,sys; sys.stdout.write('\\0'.join(os.path.realpath(p) for p in sys.argv[1:]))"
  const out = await $.process.run(['python3', '-I', '-c', code, ...paths], { cwd: cfg.vault, timeoutMs: 10_000 })
  if (out.exitCode !== 0) throw new Error(`realpath failed: ${out.stderr}`)

  return out.stdout.split('\0')
}

async function opencodeText($: EngineInterface, since: number): Promise<string> {
  const dir = cfg.cwd.replace(/'/g, "''")
  const sql = `select s.title as title, s.directory as dir, json_extract(p.data,'$.text') as text
    from part p join message m on m.id = p.message_id join session s on s.id = p.session_id
    where json_extract(m.data,'$.role') = 'assistant' and json_extract(p.data,'$.type') = 'text'
      and (s.directory = '${dir}' or s.directory like '${dir}/%')
      and p.time_created >= ${Math.floor(since)} order by p.time_created`
  try {
    const out = await $.process.run(['sqlite3', '-readonly', '-json', OPENCODE_DB, sql], { timeoutMs: 15_000 })
    if (out.exitCode !== 0 || out.stdout.trim() === '') return ''
    const rows = JSON.parse(out.stdout) as { title: string; dir: string; text: string }[]

    return redact(clipEnd(rows.map(r => `[opencode "${r.title}" in ${r.dir}] ${r.text}`).join('\n'), 4000))
  } catch {
    return ''
  }
}

function starting(batch: SecondBrainBatch, now: number): SecondBrainRunning {
  return { startedAt: now, batch, written: [], locks: [] }
}

async function releaseLocks($: EngineInterface, run: SecondBrainRunning) {
  for (const lock of run.locks) {
    const out = await $.process.run(releaseArgs(cfg.vault, WIKI, lock), { cwd: cfg.vault, timeoutMs: 15_000 })
    if (out.exitCode !== 0) $.ui.log(`second-brain: lock release ${lock.ownerId}: ${out.stderr.trim()}`, { to: 'debug' })
  }
}

// Ends the current run (its leftover locks released) and starts the next queued batch, if any.
async function finish($: EngineInterface): Promise<void> {
  staleTimer?.cancel()
  const done = await read($, running)
  // `?? []`: a run saved by the version before lock tracking has no `locks`.
  if (done !== null && (done.locks ?? []).length > 0) await releaseLocks($, done)

  const now = await $.clock.now()
  let next: SecondBrainBatch | undefined
  await update($, queue, q => { next = q[0]; return q.slice(1) })
  // The run is handed straight to the next batch, so `running` is never null while one is owed.
  await update($, running, () => (next === undefined ? null : starting(next, now)))
  $.ui.status(undefined)
  if (next !== undefined) await processBatch($, next)
}

async function processBatch($: EngineInterface, batch: SecondBrainBatch): Promise<void> {
  const text = clipEnd(batchText(batch), MAX_BATCH_CHARS)
  const gate = await $.model.complete({ model: cfg.model, system: GATE_RULES, prompt: text, effort: 'low', maxTokens: 256, timeoutMs: 30_000 })
  if (!gate.isAnswered) {
    const attempts = (batch.attempts ?? 0) + 1
    if (attempts < MAX_GATE_ATTEMPTS) {
      await update($, pending, p => (p === null ? { ...batch, attempts } : mergeBatches({ ...batch, attempts }, p)))
      later($, cfg.idleMs)
    } else {
      $.ui.log(`second-brain: gate check failed ${attempts} times (${gate.reason}); batch dropped`, { to: 'debug' })
    }
    return finish($)
  }
  if (!isDurable(gate.text)) return finish($)

  const recent = await recentNotes($)
  const worker = batch.usedHerdr ? await opencodeText($, batch.startedAt) : ''
  const prompt = [
    `Today: ${new Date(await $.clock.now()).toISOString().slice(0, 10)}`,
    `## Batch of Claude Code turns\n${text}`,
    worker === '' ? '' : `## Opencode worker output in the same window (claims to verify)\n${worker}`,
    recent.length === 0 ? '' : `## Notes changed recently in the vault (by captures or by the user)\n${recent.map(n => `- ${n}`).join('\n')}`,
  ].filter(Boolean).join('\n\n')

  const spawned = await $.agent.spawn({ subagentType: AGENT, prompt, description: 'second-brain capture', cwd: cfg.vault })
  if (spawned.deny !== undefined || spawned.agentId === undefined) {
    $.ui.toast(`second-brain: capture could not start: ${spawned.deny ?? 'no agent id'}`)
    return finish($)
  }
  const agentId = spawned.agentId
  captureAgents.add(agentId)
  const startedAt = await $.clock.now()
  await update($, running, r => (r === null ? r : { ...r, agentId, startedAt }))
  $.ui.status('second-brain: capturing…')
  staleTimer?.cancel()
  staleTimer = $.clock.after(STALE_MS, () => void expire($, agentId).catch(err => $.ui.log(`second-brain: ${String(err)}`, { to: 'debug' })))
}

async function expire($: EngineInterface, agentId: string) {
  const run = await read($, running)
  if (run === null || run.agentId !== agentId) return
  $.ui.toast('second-brain: capture timed out after 20 minutes; check the vault for partial edits')
  await finish($)
}

async function flush($: EngineInterface) {
  if (await read($, paused)) return
  let batch: SecondBrainBatch | null = null
  await update($, pending, p => { batch = p; return null })
  if (batch === null) return
  const taken: SecondBrainBatch = batch

  // Claim the single run slot in one update, so two flushes cannot both start a capture.
  const now = await $.clock.now()
  let claimed = false
  let dropped: SecondBrainRunning | null = null
  await update($, running, r => {
    if (r !== null && now - r.startedAt < STALE_MS) return r
    claimed = true
    dropped = r
    return starting(taken, now)
  })
  if (!claimed) {
    await update($, queue, q => {
      const list = [...q, taken]
      while (list.length > MAX_QUEUE) list.splice(0, 2, mergeBatches(list[0]!, list[1]!))

      return list
    })
    return
  }
  const stale: SecondBrainRunning | null = dropped
  if (stale !== null) await releaseLocks($, stale)
  await processBatch($, taken)
}

async function setPaused($: EngineInterface, isPaused: boolean) {
  await $.store.set('paused', isPaused)
  await update($, paused, () => isPaused)
  if (!isPaused) later($, 1)
}

const pad = (n: number) => String(n).padStart(2, '0')
const clockTime = (at: number) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const dayKey = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

function dayLabel(at: number, now: number) {
  if (dayKey(at) === dayKey(now)) return 'Today'
  if (dayKey(at) === dayKey(now - 86_400_000)) return 'Yesterday'
  return new Date(at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

const obsidianUrl = (path: string) => `obsidian://open?vault=${encodeURIComponent(WIKI)}&file=${encodeURIComponent(path)}`

// The pane's palette, evergreen: pine -> fern -> lichen -> amber.
type Rgb = [number, number, number]
const EVERGREEN: Rgb[] = [[52, 178, 128], [122, 214, 140], [196, 226, 120], [240, 186, 92]]
const EMPTY_CELL = '#3f4a44'
const BAR_CELLS = 12
const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0')

function evergreen(x: number): string {
  const f = Math.min(Math.max(x, 0), 1) * (EVERGREEN.length - 1)
  const i = Math.min(Math.floor(f), EVERGREEN.length - 2)
  const [a, b] = [EVERGREEN[i]!, EVERGREEN[i + 1]!]
  const t = f - i
  return `#${[0, 1, 2].map(c => hex2(a[c]! + (b[c]! - a[c]!) * t)).join('')}`
}

function later($: EngineInterface, ms: number) {
  idle?.cancel()
  idle = $.clock.after(ms, () => void flush($).catch(err => $.ui.log(`second-brain: ${String(err)}`, { to: 'debug' })))
}

function sh($: EngineInterface, argv: string[]) {
  return $.process.run(argv, { timeoutMs: 15_000 })
}

// Writes the batch whole under a temporary name, then renames it in: a claimer never reads half a file.
async function saveCarry($: EngineInterface, sessionId: string, batch: SecondBrainBatch) {
  const name = `${sessionId}-${await $.clock.now()}.json`
  const tmp = `${DATA_DIR}/tmp/${name}`
  await $.fs.write(tmp, JSON.stringify(batch))
  await sh($, ['mkdir', '-p', CARRY_DIR])
  await sh($, ['mv', tmp, `${CARRY_DIR}/${name}`])
}

// Claims every carried batch by renaming it into this session's folder. A rename is atomic, so when
// two sessions race for one file, exactly one rename succeeds and only that session captures it.
async function claimCarries($: EngineInterface): Promise<SecondBrainBatch[]> {
  if (!(await $.fs.exists(CARRY_DIR))) return []
  const mine = `${DATA_DIR}/claimed/${await $.session.id()}`
  const files = (await $.fs.list(CARRY_DIR)).filter(f => f.name.endsWith('.json'))
  if (files.length === 0) return []
  await sh($, ['mkdir', '-p', mine])
  const batches: SecondBrainBatch[] = []
  for (const f of files) {
    const to = `${mine}/${f.name}`
    if ((await sh($, ['mv', `${CARRY_DIR}/${f.name}`, to])).exitCode !== 0) continue
    try {
      batches.push(JSON.parse(await $.fs.read(to)) as SecondBrainBatch)
    } catch (err) {
      $.ui.log(`second-brain: carried batch ${to} is unreadable: ${String(err)}`, { to: 'debug' })
      continue
    }
    await sh($, ['rm', '-f', to])
  }

  return batches
}

async function loadCarry($: EngineInterface) {
  const claimed = await claimCarries($)
  // The version before carry files kept one carried batch in the store.
  const legacy = (await $.store.get('carry')) as SecondBrainBatch | undefined
  if (legacy !== undefined) { await $.store.delete('carry'); claimed.push(legacy) }
  if (claimed.length === 0) return
  const carry = claimed.reduce(mergeBatches)
  await update($, pending, p => (p === null ? carry : mergeBatches(carry, p)))
  later($, 1)
}

async function recentNotes($: EngineInterface): Promise<string[]> {
  const git = (args: string[]) => $.process.run(['git', '-C', cfg.vault, '-c', 'core.quotePath=false', ...args], { timeoutMs: 15_000 })
  const status = await git(['status', '--porcelain=v1', '--untracked-files=all'])
  const log = await git(['log', '--since=3.days', '--name-only', '--format='])

  return recentNotePaths(status.exitCode === 0 ? status.stdout : '', log.exitCode === 0 ? log.stdout : '')
}

async function complete($: EngineInterface, run: SecondBrainRunning, answer: string, isError: boolean) {
  const result = isError ? { status: 'failed' as const, summary: 'The capture agent ended with an error.', notes: [] } : parseResult(answer)
  // The mod does not commit: the edits stay in the vault's working tree for the user to review.
  const written = run.written ?? []

  if (result.status === 'failed') {
    $.ui.toast(`second-brain: capture failed: ${result.summary}${written.length === 0 ? '' : ` It changed: ${written.join(', ')}.`}`)
    return finish($)
  }
  if (result.status === 'nothing' || written.length === 0) return finish($)

  const notes: SecondBrainNote[] = result.notes.length > 0 ? result.notes : fallbackNotes(written)
  const save: SecondBrainSave = { at: await $.clock.now(), summary: result.summary, notes }
  let kept: SecondBrainSave[] = []
  await update($, saves, list => (kept = [save, ...list].slice(0, MAX_SAVES)))
  await $.store.set('saves', kept)

  const first = notes[0]
  $.ui.toast(`${first === undefined
    ? `Saved to ${WIKI}: ${result.summary}`
    : `Saved to ${WIKI}: [[${first.path}|${first.title}]]${notes.length > 1 ? ` (+${notes.length - 1} more)` : ''}`}`,
  { timeoutMs: 8000 })

  return finish($)
}

// Whether a subagent loop is a capture agent, current or not: by its type, so a call made before
// `agent.spawn` resolved, or by a capture whose run was cleared, is still held to the policy.
async function isCapture($: EngineInterface, agentId: string): Promise<boolean> {
  if (captureAgents.has(agentId)) return true
  const info = (await $.agent.list()).find(a => a.id === agentId)
  const yes = info !== undefined && (info.type === AGENT || info.spawnedBy === 'second-brain')
  if (yes) captureAgents.add(agentId)

  return yes
}

// Why the capture agent may not make this call, or undefined when it may.
async function verdict($: EngineInterface, agentId: string, tool: string, input: Record<string, unknown>): Promise<string | undefined> {
  const run = await read($, running)
  if (run === null || (run.agentId !== undefined && run.agentId !== agentId)) return 'second-brain: this capture is no longer current; stop now.'

  if (tool === 'Read') {
    const [path] = await realpaths($, [String(input.file_path ?? '')])
    const reason = readVerdict(roots(), path!)
    return reason === undefined ? undefined : `second-brain: Read refused: ${reason}.`
  }
  if (tool === 'Edit' || tool === 'Write') {
    const raw = String(input.file_path ?? '')
    const [path] = await realpaths($, [raw])
    if (!isAllowedWrite(cfg.vaultReal, path!)) return `second-brain: ${tool} is allowed only on knowledge files inside the vault, not ${raw}.`
    const rel = vaultRelative(cfg.vaultReal, path!)!
    return isLocked(run.locks, rel) ? undefined : `second-brain: acquire a write lock that lists ${rel} before you ${tool} it.`
  }
  if (tool === 'Bash') {
    const command = String(input.command ?? '')
    const { reason, paths } = bashVerdict(command, cfg.vault)
    if (reason !== undefined) return `second-brain: command refused (${reason}): ${clip(command, 120)}`
    const bad = (await realpaths($, paths)).map(p => readVerdict(roots(), p)).find(r => r !== undefined)
    return bad === undefined ? undefined : `second-brain: command refused: ${bad}.`
  }

  return `second-brain: ${tool} is not allowed for the capture agent.`
}

// After a capture agent's call succeeded: note the file it wrote, or the lock it took or released.
async function record($: EngineInterface, tool: string, input: Record<string, unknown>, stdout: string) {
  if (tool === 'Edit' || tool === 'Write') {
    const [path] = await realpaths($, [String(input.file_path ?? '')])
    const rel = vaultRelative(cfg.vaultReal, path!)
    if (rel !== undefined) await update($, running, r => (r === null || r.written.includes(rel) ? r : { ...r, written: [...r.written, rel] }))
    return
  }
  const command = String(input.command ?? '')
  if (tool !== 'Bash' || !isWriteLockCommand(command)) return
  const lock = parseAcquire(command, stdout)
  if (lock !== undefined) {
    await update($, running, r => (r === null ? r : { ...r, locks: [...r.locks, lock] }))
    return
  }
  const args = words(command)
  const owner = args.includes('release') ? args[args.indexOf('--owner-id') + 1] : undefined
  if (owner !== undefined) await update($, running, r => (r === null ? r : { ...r, locks: r.locks.filter(l => l.ownerId !== owner) }))
}

export const register: Register = (on, options) => {
  cfg.vault = String(options.vaultPath ?? cfg.vault).replace(/\/+$/, '')
  cfg.vaultReal = cfg.vault
  cfg.readRoots = String(options.readRoots ?? cfg.readRoots.join(',')).split(',').map(r => r.trim().replace(/\/+$/, '')).filter(Boolean)
  cfg.model = String(options.model ?? 'haiku')
  cfg.batchTurns = Math.max(1, Number(options.batchTurns ?? 6))
  cfg.idleMs = Math.max(1, Number(options.idleMinutes ?? 3)) * 60_000

  on('session.start', async ($, e, next) => {
    const cwd = await $.session.cwd()
    cfg.cwd = cwd
    cfg.isWatching = !(cwd === cfg.vault || cwd.startsWith(cfg.vault + '/'))
    cfg.vaultReal = (await realpaths($, [cfg.vault]))[0] ?? cfg.vault

    await $.command.register({ name: 'second-brain', description: 'Show the second-brain pane; "pause" or "resume" stops or restarts captures' })
    await $.agent.register({
      name: 'capture',
      description: 'Captures durable knowledge into the internship wiki (second-brain mod only)',
      prompt: agentPrompt(cfg.vault, roots()),
      tools: ['Read', 'Edit', 'Write', 'Bash'],
      model: cfg.model,
      skills: ['llm-wiki-crystallize', 'llm-wiki-ingest'],
      maxTurns: 40,
      omitClaudeMd: true,
    })

    const stored = ((await $.store.get('saves')) as SecondBrainSave[] | undefined) ?? []
    await update($, saves, () => stored.slice(0, MAX_SAVES))
    const isPaused = (await $.store.get('paused')) === true
    await update($, paused, () => isPaused)
    if (cfg.isWatching) await loadCarry($)

    return next(e)
  })

  on('agent.offer', { agent: AGENT }, () => ({ isOffered: false }))

  on('command.run', { command: 'second-brain' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'pause' || arg === 'resume') {
      const isPaused = arg === 'pause'
      await setPaused($, isPaused)
      return { text: isPaused ? 'second-brain paused: no turns are saved and no captures start.' : 'second-brain resumed.' }
    }
    await $.ui.open({ id: PANE, title: 'Second brain' })

    return { text: 'Second brain pane opened.' }
  })

  on('tool.check', async ($, e, next) => {
    if (e.agentId === undefined || !(await isCapture($, e.agentId))) return next(e)
    const reason = await verdict($, e.agentId, e.tool, (e.input ?? {}) as Record<string, unknown>)
    if (reason !== undefined) return { decision: 'deny', reason }
    // Keep the user's own deny rules; only lift an ask, as nobody can answer it for a background agent.
    const core = await next(e)

    return core.decision === 'ask' ? { ...core, decision: 'allow' } : core
  }).catch(($, e, next) => (e.agentId === undefined ? next(e) : { decision: 'deny', reason: 'second-brain: its guard failed.' }))

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    if (e.agentId !== undefined) {
      if (!(await isCapture($, e.agentId))) return next(e)
      const reason = await verdict($, e.agentId, String(e.tool), input)
      if (reason !== undefined) return { deny: reason }
      const out = await next(e)
      if (out.deny === undefined && out.isError !== true) {
        const stdout = String((out.result as { stdout?: unknown } | undefined)?.stdout ?? '')
        await record($, String(e.tool), input, stdout)
      }
      return out
    }
    if (cfg.isWatching) {
      const line = toolLine(String(e.tool), input)
      const herdr = e.tool === 'Bash' && isHerdrDelegation(String(input.command ?? ''))
      await update($, current, c => {
        const base = c ?? { prompt: '', tools: [], usedHerdr: false }
        return { ...base, tools: [...base.tools, line].slice(-30), usedHerdr: base.usedHerdr || herdr }
      })
    }

    return next(e)
  }).catch(($, e, next) => (next.called || e.agentId === undefined ? next(e) : { deny: 'second-brain: its guard failed.' }))

  on('turn.start', async ($, e, next) => {
    if (cfg.isWatching) {
      await update($, current, () => ({ prompt: redact(clip(e.text, 2000)), tools: [], usedHerdr: false }))
      await loadCarry($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const run = await read($, running)
      if (run !== null && run.agentId === e.agentId) {
        void complete($, run, e.answer, e.reason !== 'answer')
          .catch(err => { $.ui.toast(`second-brain: capture failed: ${String(err)}`); return finish($) })
      }
      return next(e)
    }
    if (!cfg.isWatching || e.isAborted) return next(e)

    const now = await $.clock.now()
    let turn: SecondBrainTurn = { at: now, prompt: '', tools: [], answer: redact(clipMiddle(e.answer, MAX_ANSWER_CHARS)) }
    let usedHerdr = false
    await update($, current, c => {
      if (c !== null) { turn = { ...turn, prompt: c.prompt, tools: c.tools }; usedHerdr = c.usedHerdr }
      return null
    })
    // Work on this mod is not knowledge to capture.
    const isSelf = turn.tools.some(l => l.includes($.plugin.root))
    if (isSelf || (await read($, paused))) return next(e)

    let size = 0
    await update($, pending, p => {
      const base = p ?? { startedAt: now, turns: [], usedHerdr: false }
      const merged = { ...base, turns: [...base.turns, turn].slice(-MAX_TURNS), usedHerdr: base.usedHerdr || usedHerdr }
      size = typedTurns(merged)
      return merged
    })
    later($, size >= cfg.batchTurns ? 1 : cfg.idleMs)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined && e.trigger !== 'precompute') later($, 1)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    idle?.cancel()
    let left: SecondBrainBatch | null = null
    let queued: SecondBrainBatch[] = []
    await update($, pending, p => { left = p; return null })
    await update($, queue, q => { queued = q; return [] })
    // On /clear the process and a running capture go on; on any other end the capture dies with it.
    const run = e.reason === 'clear' ? null : await read($, running)
    const all = [run?.batch, ...queued, left].filter((b): b is SecondBrainBatch => b !== undefined && b !== null)
    if (all.length > 0) await saveCarry($, e.sessionId, all.reduce(mergeBatches))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const list = await read($, saves)
    const run = await read($, running)
    const wait = await read($, pending)
    const isPaused = await read($, paused)
    const now = await $.clock.now()
    const isNarrow = e.props.bodyColumns < 48

    const filled = Math.min(cfg.batchTurns, run !== null ? typedTurns(run.batch) : wait !== null ? typedTurns(wait) : 0)
    const head = isPaused
      ? { title: 'Paused', color: 'warning', hint: 'Nothing is saved while paused.' }
      : run !== null
        ? { title: 'Writing to the vault', color: 'suggestion', hint: `Started ${clockTime(run.startedAt)}. Edits stay uncommitted for you to review.` }
        : filled > 0
          ? { title: 'Collecting turns', color: 'suggestion', hint: `A capture starts at ${cfg.batchTurns} turns, after ${cfg.idleMs / 60_000} min idle, or on compaction.` }
          : { title: 'Listening', color: 'subtle', hint: 'Turns with durable knowledge are filed in the vault.' }

    const days: { label: string; items: SecondBrainSave[] }[] = []
    for (const s of [...list].sort((a, b) => b.at - a.at)) {
      const label = dayLabel(s.at, now)
      const last = days[days.length - 1]
      if (last?.label === label) last.items.push(s)
      else days.push({ label, items: [s] })
    }

    // Drawn cell by cell, so one gradient runs across a box or a bar `total` cells wide.
    const paint = (str: string, x0: number, total: number, key: string) =>
      [...str].map((ch, i) => <Text key={`${key}${i}`} color={evergreen((x0 + i) / Math.max(1, total - 1))} bold>{ch}</Text>)
    const section = (icon: string, title: string, x: number) => (
      <Text bold color={evergreen(x)}>{icon} {title}</Text>
    )
    const row = (key: string, value: RenderChildren) => (
      <Box key={key} flexDirection="row">
        <Box width={8} flexShrink={0}><Text dimColor>{key}</Text></Box>
        {value}
      </Box>
    )

    if (!cfg.isWatching) {
      return (
        <Box flexDirection="column" paddingX={1}>
          {section('◉', 'BRAIN', 0)}
          {row('state', <Text bold color="subtle">Not watching</Text>)}
          <Text dimColor>This session runs inside the vault, so its turns are not captured.</Text>
        </Box>
      )
    }

    // The box keeps one width ("resume" is the longer label), so it does not jump when pressed.
    const label = (isPaused ? 'resume' : 'pause').padEnd(6)
    const inner = label.length + 5
    const boxW = inner + 2
    const lit = Math.round((filled / cfg.batchTurns) * BAR_CELLS)

    return (
      <Box flexDirection="column" paddingX={1}>
        {section('◉', 'BRAIN', 0)}
        {row('state', <Text bold color={head.color}>{head.title}</Text>)}
        {!isPaused && row('batch', (
          <Box flexDirection="row">
            {[...Array(BAR_CELLS).keys()].map(i => (
              <Text key={`c${i}`} color={i < lit ? evergreen(i / (BAR_CELLS - 1)) : EMPTY_CELL}>{i < lit ? '█' : '░'}</Text>
            ))}
            {!isNarrow && <Box marginLeft={2}><Text dimColor>{`${filled} of ${cfg.batchTurns} turns`}</Text></Box>}
          </Box>
        ))}
        <Text dimColor>{head.hint}</Text>

        <Box flexDirection="column" marginTop={1}>
          <Box>{paint(`╭${'─'.repeat(inner)}╮`, 0, boxW, 't')}</Box>
          <Box>
            {paint('│', 0, boxW, 'l')}
            <Button key="toggle-pause" label={label.trim()} hotkey="p" plain onPress={() => void setPaused($, !isPaused)}>
              {paint(` ${label} `, 4, boxW, 'b')}
            </Button>
            {paint('│', boxW - 1, boxW, 'r')}
          </Box>
          <Box>{paint(`╰${'─'.repeat(inner)}╯`, 0, boxW, 'u')}</Box>
        </Box>

        <Box marginTop={1}>{section('✎', 'SAVES', 0.66)}</Box>
        {days.length === 0 && <Text dimColor>No captures yet. Saved notes appear here, newest first.</Text>}
        {days.map((day, di) => (
          <Box key={day.label} flexDirection="column" marginTop={di === 0 ? 0 : 1}>
            <Text bold color={evergreen(0.33)}>{day.label}</Text>
            {day.items.map(s => (
              <Box key={String(s.at)} flexDirection="row" marginTop={1}>
                <Box width={7} flexShrink={0}>
                  <Text color="subtle">{clockTime(s.at)}</Text>
                </Box>
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Text>{s.summary}</Text>
                  {s.notes.map(n => (
                    <Text wrap="truncate-end">
                      <Text color={evergreen(1)}>↳ </Text>
                      <Link href={obsidianUrl(n.path)}>{n.title || n.path}</Link>
                      {!isNarrow && n.title && <Text dimColor>  {n.path}</Text>}
                    </Text>
                  ))}
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
