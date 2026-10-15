import { describe, expect, mock, test } from 'claude-code/testing'

import {
  batchText, bashVerdict, clipMiddle, fallbackNotes, isAllowedBash, isAllowedWrite, isDurable,
  isHerdrDelegation, isLocked, mergeBatches, parseAcquire, parseResult, readVerdict, recentNotePaths,
  baseName, expandHome, redact, releaseArgs, typedTurns, vaultPathsFromObsidian, vaultReason, vaultScore, vaultWarnings,
} from '../hooks/policy'

const VAULT = '/v/wiki'
const LOCK = `python3 scripts/write_lock.py --root ${VAULT} --wiki w --scope files`

describe('capture agent Bash policy', () => {
  test('allows read-only commands, sleep and the lock helper', async () => {
    expect(isAllowedBash('rg -n "group order" wiki', VAULT)).toBe(true)
    expect(isAllowedBash('git log --oneline -5', VAULT)).toBe(true)
    expect(isAllowedBash('git diff HEAD~1 -- wiki/a.md', VAULT)).toBe(true)
    expect(isAllowedBash('find wiki -name "*.md"', VAULT)).toBe(true)
    expect(isAllowedBash('sleep 10', VAULT)).toBe(true)
    expect(isAllowedBash('sleep 60', VAULT)).toBe(true)
    expect(isAllowedBash(`${LOCK} status --path a.md`, VAULT)).toBe(true)
  })

  test('denies writes, deletes and shell operators', async () => {
    expect(isAllowedBash('rm wiki/a.md', VAULT)).toBe(false)
    expect(isAllowedBash('mv a.md b.md', VAULT)).toBe(false)
    expect(isAllowedBash('find wiki -delete', VAULT)).toBe(false)
    expect(isAllowedBash('git commit -m x', VAULT)).toBe(false)
    expect(isAllowedBash('cat a.md > b.md', VAULT)).toBe(false)
    expect(isAllowedBash('ls; rm -rf /', VAULT)).toBe(false)
    expect(isAllowedBash('python3 -c "import os"', VAULT)).toBe(false)
    expect(isAllowedBash('cat $(echo a)', VAULT)).toBe(false)
    expect(isAllowedBash('cat ~/.ssh/id_rsa', VAULT)).toBe(false)
    expect(isAllowedBash('sleep 61', VAULT)).toBe(false)
    expect(isAllowedBash('sleep 999', VAULT)).toBe(false)
  })

  test('denies flags that run programs, write files or widen reads', async () => {
    expect(isAllowedBash('rg --pre=sh x', VAULT)).toBe(false)
    expect(isAllowedBash('rg --pre sh x', VAULT)).toBe(false)
    expect(isAllowedBash('rg --pre-glob "*" x', VAULT)).toBe(false)
    expect(isAllowedBash('rg -z x', VAULT)).toBe(false)
    expect(isAllowedBash('rg --hidden x', VAULT)).toBe(false)
    expect(isAllowedBash('rg -uu x', VAULT)).toBe(false)
    expect(isAllowedBash('grep -rn x wiki', VAULT)).toBe(false)
    expect(isAllowedBash('git diff --output=wiki/x.md', VAULT)).toBe(false)
    expect(isAllowedBash('git log --output wiki/x.md', VAULT)).toBe(false)
    expect(isAllowedBash('git diff --ext-diff', VAULT)).toBe(false)
    expect(isAllowedBash('git show --textconv HEAD', VAULT)).toBe(false)
    expect(isAllowedBash('git diff --no-index a b', VAULT)).toBe(false)
    expect(isAllowedBash('find . -fprint0 out', VAULT)).toBe(false)
    expect(isAllowedBash('find . -fprint out', VAULT)).toBe(false)
    expect(isAllowedBash('find . -execdir ls', VAULT)).toBe(false)
    expect(isAllowedBash('find . -okdir ls', VAULT)).toBe(false)
    expect(isAllowedBash('find -L .', VAULT)).toBe(false)
  })

  test('allows the lease arguments on acquire and still reads the paths', async () => {
    const acquire = `${LOCK} acquire --path wiki/a.md log/x.md --holder claude:second-brain-capture --reason capture-notes --ttl 15`
    expect(isAllowedBash(acquire, VAULT)).toBe(true)
    expect(parseAcquire(acquire, 'Acquired 2 w file lock(s). Owner ID: abc-123')).toEqual({ scope: 'files', paths: ['wiki/a.md', 'log/x.md'], ownerId: 'abc-123' })
  })

  test('holds the lock helper to this vault', async () => {
    expect(isAllowedBash('python3 scripts/write_lock.py --root /tmp/x --wiki w --scope files status', VAULT)).toBe(false)
    expect(isAllowedBash(`${LOCK} status --root /tmp/x`, VAULT)).toBe(false)
    expect(isAllowedBash('python3 scripts/write_lock.py --root=/v/wiki --wiki w --scope files status', VAULT)).toBe(false)
  })

  test('returns the file arguments to resolve', async () => {
    expect(bashVerdict('cat /etc/passwd wiki/a.md', VAULT).paths).toEqual(['/etc/passwd', 'wiki/a.md'])
    expect(bashVerdict('rg --glob=/x/y z', VAULT).paths).toEqual(['/x/y', 'z'])
  })

  test('returns the paths as the shell will open them, quotes removed', async () => {
    expect(bashVerdict('cat /v/"wiki/.."/../x', VAULT).paths).toEqual(['/v/wiki/../../x'])
    expect(bashVerdict("cat '/v/wiki'/a.md", VAULT).paths).toEqual(['/v/wiki/a.md'])
    expect(bashVerdict('rg -n "group order" wiki', VAULT).paths).toEqual(['group order', 'wiki'])
  })

  test('refuses what the guard cannot read the way the shell does', async () => {
    expect(isAllowedBash('cat /v/{wiki,..}/x', VAULT)).toBe(false)
    expect(isAllowedBash('cat /v/wiki/*', VAULT)).toBe(false)
    expect(isAllowedBash('ls wiki/a?.md', VAULT)).toBe(false)
    expect(isAllowedBash('cat wiki/a\\ b', VAULT)).toBe(false)
    expect(isAllowedBash('cat "wiki/a', VAULT)).toBe(false)
    expect(isAllowedBash('find wiki -name "*.md"', VAULT)).toBe(true)
  })
})

describe('read and write paths', () => {
  const roots = [VAULT, '/src']

  test('holds reads to the roots and away from credentials', async () => {
    expect(readVerdict(roots, '/src/repo/main.go')).toBeUndefined()
    expect(readVerdict(roots, '/V/WIKI/wiki/a.md')).toBeUndefined()
    expect(readVerdict(roots, '/etc/hosts')).toBeDefined()
    expect(readVerdict(roots, '/src-other/x')).toBeDefined()
    expect(readVerdict(roots, '/src/repo/.env')).toBeDefined()
    expect(readVerdict(roots, '/src/repo/.env.local')).toBeDefined()
    expect(readVerdict(roots, '/src/repo/deploy.pem')).toBeDefined()
    expect(readVerdict(roots, '/src/.aws/credentials')).toBeDefined()
  })

  test('limits Edit and Write to knowledge files in the vault', async () => {
    expect(isAllowedWrite(VAULT, '/v/wiki/wiki/topic/note.md')).toBe(true)
    expect(isAllowedWrite(VAULT, '/v/wiki/log/2026-10-15.md')).toBe(true)
    expect(isAllowedWrite(VAULT, '/v/wiki/AGENTS.md')).toBe(false)
    expect(isAllowedWrite(VAULT, '/v/wiki/agents.MD')).toBe(false)
    expect(isAllowedWrite(VAULT, '/v/wiki/Schema/lifecycle.md')).toBe(false)
    expect(isAllowedWrite(VAULT, '/v/wiki/.git/config')).toBe(false)
    expect(isAllowedWrite(VAULT, '/v/wiki/.GIT/config')).toBe(false)
    expect(isAllowedWrite(VAULT, '/V/WIKI/.git/config')).toBe(false)
    expect(isAllowedWrite(VAULT, '/v/wiki/.claude/settings.json')).toBe(false)
    expect(isAllowedWrite(VAULT, '/v/wiki/.claudian/x')).toBe(false)
    expect(isAllowedWrite(VAULT, '/v/wiki/.gitignore')).toBe(false)
    expect(isAllowedWrite(VAULT, '/v/wiki/.gitattributes')).toBe(false)
    expect(isAllowedWrite(VAULT, '/v/wiki/./AGENTS.md')).toBe(false)
    expect(isAllowedWrite(VAULT, '/v/wiki/../other/x.md')).toBe(false)
    expect(isAllowedWrite(VAULT, '/v/wiki-other/x.md')).toBe(false)
    expect(isAllowedWrite(VAULT, '/etc/hosts')).toBe(false)
  })

  test('requires a lock on the written path', async () => {
    expect(isLocked([{ scope: 'files', paths: ['wiki/a.md'], ownerId: 'o' }], 'wiki/a.md')).toBe(true)
    expect(isLocked([{ scope: 'files', paths: ['wiki/a.md'], ownerId: 'o' }], 'wiki/b.md')).toBe(false)
    expect(isLocked([{ scope: 'vault', paths: [], ownerId: 'o' }], 'wiki/b.md')).toBe(true)
    expect(isLocked([], 'wiki/a.md')).toBe(false)
  })

  test('reads an acquire and builds its release', async () => {
    const lock = parseAcquire(`${LOCK} acquire --path ./Wiki/A.md log/x.md`, 'Acquired 2 w file lock(s). Owner ID: abc-123')
    expect(lock).toEqual({ scope: 'files', paths: ['wiki/a.md', 'log/x.md'], ownerId: 'abc-123' })
    expect(parseAcquire(`${LOCK} acquire --path a.md`, 'write-lock: conflict')).toBeUndefined()
    expect(releaseArgs(VAULT, 'w', lock!)).toEqual(['python3', 'scripts/write_lock.py', '--root', VAULT, '--wiki', 'w', '--scope', 'files', 'release', '--path', 'wiki/a.md', 'log/x.md', '--owner-id', 'abc-123'])
  })
})

describe('batches, gate and results', () => {
  const turn = { at: 1, prompt: 'p', tools: [], answer: 'a' }

  test('detects Herdr delegation', async () => {
    expect(isHerdrDelegation('herdr agent send opencode "fix it"')).toBe(true)
    expect(isHerdrDelegation('herdr pane list --workspace w1')).toBe(false)
  })

  test('reads the gate answer strictly', async () => {
    expect(isDurable('durable')).toBe(true)
    expect(isDurable(' Durable.')).toBe(true)
    expect(isDurable('**durable**')).toBe(true)
    expect(isDurable('not durable')).toBe(false)
    expect(isDurable('nothing')).toBe(false)
  })

  test('counts only turns with a typed prompt', async () => {
    expect(typedTurns({ startedAt: 1, turns: [turn, { ...turn, prompt: '  ' }, turn], usedHerdr: false })).toBe(2)
  })

  test('merges batches and keeps at most 12 turns', async () => {
    const a = { startedAt: 5, turns: Array(8).fill(turn), usedHerdr: false, attempts: 1 }
    const b = { startedAt: 2, turns: Array(8).fill(turn), usedHerdr: true }
    const m = mergeBatches(a, b)
    expect(m.startedAt).toBe(2)
    expect(m.turns.length).toBe(12)
    expect(m.usedHerdr).toBe(true)
    expect(m.attempts).toBe(1)
    expect(batchText(m)).toContain('### Turn 12')
  })

  test('parses the last SECOND_BRAIN line', async () => {
    const r = parseResult('done\nSECOND_BRAIN {"status":"saved","summary":"Added X","notes":[{"path":"wiki/a","title":"A"}]}')
    expect(r.status).toBe('saved')
    expect(r.notes).toEqual([{ path: 'wiki/a', title: 'A' }])
    expect(parseResult('SECOND_BRAIN {"status":"blocked","summary":"vault lock held by x","notes":[]}')).toEqual({ status: 'blocked', summary: 'vault lock held by x', notes: [] })
    expect(parseResult('no line').status).toBe('failed')
    expect(parseResult('SECOND_BRAIN {bad').status).toBe('failed')
  })

  test('redacts secrets', async () => {
    // Fake key, split so secret scanners do not flag the fixture.
    expect(redact(`key ${'AKIA' + 'ABCDEFGHIJKLMNOP'} here`)).toBe('key [redacted] here')
    expect(redact('password=hunter2hunter2')).toBe('password=[redacted]')
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toContain('Bearer [redacted]')
    expect(redact('the author: Ng')).toBe('the author: Ng')
  })

  test('clips a long answer in the middle, keeping both ends', async () => {
    expect(clipMiddle('short', 10)).toBe('short')
    const long = `START${'x'.repeat(100)}END`
    const out = clipMiddle(long, 20)
    expect(out.startsWith('START')).toBe(true)
    expect(out.endsWith('END')).toBe(true)
    expect(out).toContain(`[cut ${long.length - 20} chars]`)
  })

  test('lists recent notes from git status and log', async () => {
    const status = ' M wiki/a.md\n?? wiki/new note.md\nR  wiki/old.md -> wiki/moved.md\n M .obsidian/workspace.json\n M scripts/x.py\n'
    const log = 'wiki/a.md\nlog/2026-10-15.md\n\nwiki/b.md\n'
    expect(recentNotePaths(status, log)).toEqual(['wiki/a', 'wiki/new note', 'wiki/moved', 'log/2026-10-15', 'wiki/b'])
    expect(recentNotePaths(status, log, 2)).toEqual(['wiki/a', 'wiki/new note'])
  })

  test('prefers real notes over log and index paths for the toast', async () => {
    expect(fallbackNotes(['log/2026-10-15.md', 'wiki/index.md', 'wiki/go/a.md']).map(n => n.path)).toEqual(['wiki/go/a'])
    expect(fallbackNotes(['log/2026-10-15.md']).map(n => n.path)).toEqual(['log/2026-10-15'])
  })
})

test('pane shows the status and its button pauses and resumes', { options: { vaultPath: '/v/wiki' } }, async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 15, 4) })
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'second-brain', surface, component: 'Pane', requestId: 'second-brain',
      props: { title: 'Second brain', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: 'Listening' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '0 of 6 turns' })).toBeDefined()
    await ui.press({ key: 'toggle-pause' })
    expect(await ui.find({ type: 'Text', text: 'Paused' })).toBeDefined()
    await ui.press({ key: 'toggle-pause' })
    expect(await ui.find({ type: 'Text', text: 'Listening' })).toBeDefined()
    await ui.unmount()
  }
})

test('pane asks for a vault while none is set', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 15, 4) })
  mock.store(on)
  const ui = await $.ui.mount({
    plugin: 'second-brain', surface: 'terminal', component: 'Pane', requestId: 'second-brain',
    props: { title: 'Second brain', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: 'Nothing is captured until you finish these two steps.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '⟳ Looking for your knowledge wiki…' })).toBeDefined()
  await ui.unmount()
})

test('lets main-loop tool calls through unchanged', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x' })
  expect(ran.deny).toBeUndefined()
  expect(ran.result).toBe('ok')
})

describe('first-run vault setup helpers', () => {
  test('reads vault paths from obsidian.json', async () => {
    const json = JSON.stringify({ vaults: { a: { path: '/h/wiki/' }, b: { path: '/h/notes' }, c: {} } })
    expect(vaultPathsFromObsidian(json)).toEqual(['/h/wiki', '/h/notes'])
    expect(vaultPathsFromObsidian('not json')).toEqual([])
  })

  test('ranks and describes a folder by its markers', async () => {
    const full = { obsidian: true, agents: true, lock: true }
    const plain = { obsidian: false, agents: false, lock: false }
    expect(vaultScore(full)).toBeGreaterThan(vaultScore({ obsidian: true, agents: false, lock: false }))
    expect(vaultReason(full)).toBe('Obsidian vault, has AGENTS.md, has scripts/write_lock.py')
    expect(vaultReason(plain)).toBe('plain folder')
    expect(vaultWarnings(full)).toEqual([])
    expect(vaultWarnings(plain)).toHaveLength(2)
  })

  test('expands ~ and trims a trailing slash', async () => {
    expect(expandHome('~/wiki/', '/h')).toBe('/h/wiki')
    expect(expandHome('~', '/h')).toBe('/h')
    expect(expandHome(' /a/b ', '/h')).toBe('/a/b')
    expect(baseName('/a/my-wiki/')).toBe('my-wiki')
  })
})
