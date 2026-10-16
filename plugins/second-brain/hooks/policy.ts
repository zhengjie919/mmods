import type { SecondBrainBatch, SecondBrainLock, SecondBrainNote } from '../types'

// Pure helpers: the capture agent's tool policy, batch text, and result parsing.

export const MAX_TURNS = 12

const SHELL_META = /[;&|<>`\n\r$]|(^|[\s=:])~/
const READ_ONLY = new Set(['rg', 'grep', 'ls', 'cat', 'head', 'tail', 'wc', 'date', 'pwd', 'find'])
const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'ls-files'])
// Flags that run another program, write a file, follow links out of a root, or read hidden/ignored files.
const DENIED_FLAGS: Record<string, RegExp> = {
  rg: /^(--pre|--search-zip$|-[a-zA-Z]*[zLu.]|--follow$|--hidden$|--no-ignore|--unrestricted$)/,
  grep: /^(-[a-zA-Z]*[rR]|--recursive$|--dereference-recursive$|--directories|-d$)/,
  find: /^-(exec|ok|delete|f|L$|H$)/,
  git: /^(--output|-o$|--ext-diff$|--textconv$|--no-index$)/,
}
const PROTECTED = [/^agents\.md$/, /^claude\.md$/, /^schema\//, /^scripts\//, /^maintenance\/\.write-lock/]
const CREDENTIALS = [
  /\/\.(ssh|aws|gnupg|kube|docker|azure|gcloud|password-store)(\/|$)/, /\/\.config\/(gh|gcloud)(\/|$)/,
  /\/\.(netrc|npmrc|pypirc|git-credentials|pgpass|claude\.json)$/, /\/\.env(\.[^/]*)?$/,
  /\/id_(rsa|dsa|ecdsa|ed25519)[^/]*$/, /\.(pem|key|p12|pfx|keystore|jks)$/, /\/credentials[^/]*$/,
]

export function words(command: string): string[] {
  return command.trim().split(/\s+/).map(w => w.replace(/^['"]|['"]$/g, ''))
}

// Splits like the shell does: quotes group words and vanish, so the guard sees the paths the command opens.
// Undefined when the shell would do more than this: a backslash, a brace or wildcard outside quotes, an open quote.
function shellWords(command: string): string[] | undefined {
  if (command.includes('\\')) return undefined
  const out: string[] = []
  let word = ''
  let isWord = false
  let quote = ''
  for (const ch of command) {
    if (quote !== '') {
      if (ch === quote) quote = ''
      else word += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      isWord = true
    } else if (/\s/.test(ch)) {
      if (isWord) out.push(word)
      word = ''
      isWord = false
    } else if (/[{}*?[\]]/.test(ch)) {
      return undefined
    } else {
      word += ch
      isWord = true
    }
  }
  if (quote !== '') return undefined
  if (isWord) out.push(word)

  return out
}

export function isWriteLockCommand(command: string): boolean {
  const [program, script] = words(command)

  return (program === 'python3' || program === 'python') && script === 'scripts/write_lock.py'
}

// Returns why `command` is refused, or undefined when it may run. `paths` lists its arguments that
// name files, to be resolved and held to the read roots by the caller.
export function bashVerdict(command: string, vault: string): { reason?: string; paths: string[] } {
  if (SHELL_META.test(command)) return { reason: 'shell operators, $ and ~ are not allowed', paths: [] }
  const tokens = shellWords(command)
  if (tokens === undefined) return { reason: 'backslashes, open quotes, and braces or wildcards outside quotes are not allowed', paths: [] }
  const [program, ...args] = tokens
  if (program === undefined) return { reason: 'empty command', paths: [] }

  if (program === 'python3' || program === 'python') {
    if (args[0] !== 'scripts/write_lock.py') return { reason: 'python runs only scripts/write_lock.py', paths: [] }
    const roots = args.filter(a => a === '--root' || a.startsWith('--root='))
    const at = args.indexOf('--root')
    if (roots.length !== 1 || at < 0 || args[at + 1] !== vault) return { reason: `the lock helper needs exactly --root ${vault}`, paths: [] }
    return { paths: [] }
  }
  if (program === 'sleep') {
    return args.length === 1 && /^\d+$/.test(args[0]!) && Number(args[0]) <= 60 ? { paths: [] } : { reason: 'sleep takes one whole number of seconds, at most 60', paths: [] }
  }
  if (program === 'git') {
    if (args[0] === undefined || !GIT_READ_ONLY.has(args[0])) return { reason: 'git allows only status, diff, log, show and ls-files', paths: [] }
  } else if (!READ_ONLY.has(program)) {
    return { reason: `${program} is not on the allow-list`, paths: [] }
  }

  const rest = program === 'git' ? args.slice(1) : args
  const denied = DENIED_FLAGS[program]
  const bad = denied === undefined ? undefined : rest.find(a => denied.test(a))
  if (bad !== undefined) return { reason: `the flag ${bad} is not allowed for ${program}`, paths: [] }

  const paths = rest
    .map(a => (a.startsWith('-') ? (a.includes('=') ? a.slice(a.indexOf('=') + 1) : '') : a))
    .filter(a => a !== '')

  return { paths }
}

export function isAllowedBash(command: string, vault: string): boolean {
  return bashVerdict(command, vault).reason === undefined
}

function isUnder(root: string, path: string): boolean {
  const r = root.toLowerCase().replace(/\/+$/, '')
  const p = path.toLowerCase()

  return p === r || p.startsWith(r + '/')
}

export function isCredentialPath(path: string): boolean {
  const p = path.toLowerCase()

  return CREDENTIALS.some(re => re.test(p))
}

// `path` is already resolved (absolute, symlinks and `..` gone).
export function readVerdict(roots: string[], path: string): string | undefined {
  if (isCredentialPath(path)) return `${path} may hold credentials`
  if (!roots.some(r => isUnder(r, path))) return `${path} is outside the read roots (${roots.join(', ')})`

  return undefined
}

// The vault-relative path, lowercased, of a resolved path inside the vault; undefined otherwise.
export function vaultRelative(vault: string, filePath: string): string | undefined {
  if (!isUnder(vault, filePath) || filePath.length <= vault.length + 1) return undefined
  const rel = filePath.slice(vault.length + 1).toLowerCase()
  if (rel.split('/').some(part => part === '' || part === '.' || part === '..')) return undefined

  return rel
}

// `filePath` is already resolved. Dot files and dot folders (.git, .obsidian, .claude, .gitignore, ...) are never writable.
export function isAllowedWrite(vault: string, filePath: string): boolean {
  const rel = vaultRelative(vault, filePath)

  return rel !== undefined && !rel.split('/').some(part => part.startsWith('.')) && !PROTECTED.some(re => re.test(rel))
}

export function isLocked(locks: SecondBrainLock[], rel: string): boolean {
  return locks.some(l => l.scope === 'vault' || l.paths.includes(rel))
}

// Reads a successful `write_lock.py ... acquire` call into the lock it took.
export function parseAcquire(command: string, stdout: string): SecondBrainLock | undefined {
  const args = words(command)
  const owner = /Owner ID: (\S+)/.exec(stdout)?.[1]
  if (!args.includes('acquire') || owner === undefined) return undefined
  const scope = args[args.indexOf('--scope') + 1] === 'vault' ? 'vault' : 'files'
  const at = args.indexOf('--path')
  const after = at < 0 ? [] : args.slice(at + 1)
  const end = after.findIndex(a => a.startsWith('--'))
  const paths = end < 0 ? after : after.slice(0, end)

  return { scope, paths: paths.map(p => p.replace(/^\.\//, '').toLowerCase()), ownerId: owner }
}

export function releaseArgs(vault: string, wiki: string, lock: SecondBrainLock): string[] {
  const paths = lock.scope === 'files' ? ['--path', ...lock.paths] : []

  return ['python3', 'scripts/write_lock.py', '--root', vault, '--wiki', wiki, '--scope', lock.scope, 'release', ...paths, '--owner-id', lock.ownerId]
}

// Keeps the head.
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[cut ${text.length - max} chars]`
}

// Keeps the tail, the newest part of a log-like text.
export function clipEnd(text: string, max: number): string {
  return text.length <= max ? text : `[cut ${text.length - max} older chars]…${text.slice(-max)}`
}

// Keeps both ends: an answer's opening and its closing summary.
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil(max / 2)

  return `${text.slice(0, head)}…[cut ${text.length - max} chars]…${text.slice(text.length - (max - head))}`
}

const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[redacted]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 [redacted]'],
  [/\b(api[_-]?key|secret|token|password|passwd|pwd|auth)(["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1$2[redacted]'],
]

export function redact(text: string): string {
  return SECRETS.reduce((t, [re, to]) => t.replace(re, to), text)
}

export function toolLine(tool: string, input: Record<string, unknown>): string {
  const target = input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? ''

  return clip(redact(`${tool} ${String(target)}`.trim()), 200)
}

export function isHerdrDelegation(command: string): boolean {
  return /\bherdr\b/.test(command) && /\b(send|run|prompt|opencode)\b/.test(command)
}

export function isDurable(gateText: string): boolean {
  return /^\s*["'*]*durable\b/i.test(gateText)
}

export function typedTurns(batch: SecondBrainBatch): number {
  return batch.turns.filter(t => t.prompt.trim() !== '').length
}

export function batchText(batch: SecondBrainBatch): string {
  return batch.turns
    .map((t, i) => {
      const tools = t.tools.length === 0 ? '(none)' : t.tools.map(l => `  - ${l}`).join('\n')
      const user = t.prompt.trim() === '' ? '(no typed prompt: a continuation or notification)' : t.prompt

      return `### Turn ${i + 1} (${new Date(t.at).toISOString()})\nUser: ${user}\nTool calls:\n${tools}\nClaude: ${t.answer}`
    })
    .join('\n\n')
}

export function mergeBatches(a: SecondBrainBatch, b: SecondBrainBatch): SecondBrainBatch {
  return {
    startedAt: Math.min(a.startedAt, b.startedAt),
    turns: [...a.turns, ...b.turns].slice(-MAX_TURNS),
    usedHerdr: a.usedHerdr || b.usedHerdr,
    attempts: Math.max(a.attempts ?? 0, b.attempts ?? 0),
  }
}

export type CaptureResult = { status: 'saved' | 'nothing' | 'blocked' | 'failed'; summary: string; notes: SecondBrainNote[] }

// The JSON after `SECOND_BRAIN ` on a result line; undefined when it is not valid JSON.
function readResultLine(line: string): Partial<CaptureResult> | undefined {
  try {
    return (JSON.parse(line.trim().slice('SECOND_BRAIN '.length)) as Partial<CaptureResult> | null) ?? undefined
  } catch {
    return undefined
  }
}

export function parseResult(answer: string): CaptureResult {
  const line = answer.split('\n').reverse().find(l => l.trim().startsWith('SECOND_BRAIN '))
  if (line === undefined) return { status: 'failed', summary: 'The capture agent gave no SECOND_BRAIN result line.', notes: [] }
  try {
    const raw = JSON.parse(line.trim().slice('SECOND_BRAIN '.length)) as Partial<CaptureResult>
    const status = raw.status === 'saved' || raw.status === 'nothing' || raw.status === 'blocked' ? raw.status : 'failed'
    const notes = Array.isArray(raw.notes)
      ? raw.notes.filter(n => typeof n?.path === 'string').map(n => ({ path: n.path, title: String(n.title ?? n.path) }))
      : []

    return { status, summary: String(raw.summary ?? ''), notes }
  } catch {
    return { status: 'failed', summary: 'The capture agent result line is not valid JSON.', notes: [] }
  }
}

// True when a delivery's text carries a capture agent's result line (`SECOND_BRAIN {...}`) that parses as JSON.
// The line may sit indented inside a harness frame. A sentence that only mentions SECOND_BRAIN does not count.
export function isCaptureHandback(text: string): boolean {
  return text.split('\n').some(l => {
    const line = l.trim()
    return line.startsWith('SECOND_BRAIN {') && readResultLine(line) !== undefined
  })
}

// Notes worth a toast when the agent named none: not the daily log, not an index.
export function fallbackNotes(paths: string[]): SecondBrainNote[] {
  const md = paths.filter(p => p.endsWith('.md'))
  const main = md.filter(p => !p.startsWith('log/') && !/(^|\/)index\.md$/.test(p))

  return (main.length > 0 ? main : md).map(p => ({ path: p.replace(/\.md$/, ''), title: p.replace(/\.md$/, '').split('/').pop() ?? p }))
}

// Recently changed notes, from `git status --porcelain=v1` (uncommitted, newest first in practice) and
// `git log --name-only --format=` (recent commits): vault-relative, without .md, at most `max`.
export function recentNotePaths(status: string, log: string, max = 20): string[] {
  const fromStatus = status.split('\n').filter(l => l.length > 3).map(l => {
    const path = l.slice(3)
    return path.includes(' -> ') ? path.slice(path.indexOf(' -> ') + 4) : path
  })
  const fromLog = log.split('\n').map(l => l.trim())
  const notes = [...fromStatus, ...fromLog]
    .filter(p => p.endsWith('.md') && !p.split('/').some(part => part.startsWith('.')))
    .map(p => p.replace(/^"|"$/g, '').replace(/\.md$/, ''))

  return [...new Set(notes)].slice(0, max)
}

// First-run setup: what a folder offers, read from its markers, and how to describe it.
export type VaultMarkers = { obsidian: boolean; agents: boolean; lock: boolean }

export function vaultPathsFromObsidian(json: string): string[] {
  try {
    const vaults = (JSON.parse(json) as { vaults?: Record<string, { path?: unknown }> }).vaults ?? {}
    return Object.values(vaults).map(v => (typeof v.path === 'string' ? v.path.replace(/\/+$/, '') : '')).filter(p => p !== '')
  } catch {
    return []
  }
}

export function vaultScore(m: VaultMarkers): number {
  return (m.lock ? 4 : 0) + (m.agents ? 2 : 0) + (m.obsidian ? 1 : 0)
}

export function vaultReason(m: VaultMarkers): string {
  const found = [m.obsidian && 'Obsidian vault', m.agents && 'has AGENTS.md', m.lock && 'has scripts/write_lock.py'].filter(Boolean)
  return found.length === 0 ? 'plain folder' : found.join(', ')
}

// What the capture agent cannot do in this folder. It writes only through the lock helper, and reads AGENTS.md first.
export function vaultWarnings(m: VaultMarkers): string[] {
  return [
    m.lock ? '' : 'No scripts/write_lock.py: the capture agent cannot write here until the vault has it.',
    m.agents ? '' : 'No AGENTS.md: the capture agent expects a policy there that allows captures.',
  ].filter(w => w !== '')
}

export function expandHome(path: string, home: string): string {
  const p = path.trim()
  return (p === '~' ? home : p.startsWith('~/') ? `${home}/${p.slice(2)}` : p).replace(/\/+$/, '')
}

export function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? ''
}
