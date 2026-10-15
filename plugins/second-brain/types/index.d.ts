export type SecondBrainTurn = { at: number; prompt: string; tools: string[]; answer: string }

export type SecondBrainBatch = { startedAt: number; turns: SecondBrainTurn[]; usedHerdr: boolean; attempts?: number }

export type SecondBrainLock = { scope: 'files' | 'vault'; paths: string[]; ownerId: string }

export type SecondBrainRunning = {
  // Absent while the gate check and the spawn are still in progress.
  agentId?: string
  startedAt: number
  batch: SecondBrainBatch
  // Vault-relative, lowercased paths the agent wrote, and the locks it took.
  written: string[]
  locks: SecondBrainLock[]
}

export type SecondBrainNote = { path: string; title: string }

export type SecondBrainSave = { at: number; summary: string; notes: SecondBrainNote[] }

export type SecondBrainCurrent = { prompt: string; tools: string[]; usedHerdr: boolean }

export type SecondBrainCandidate = { path: string; reason: string; warnings: string[]; hint: string }

export type SecondBrainRootChoice = { path: string; on: boolean }

// First-run setup: scanning for a vault, picking one, confirming it, or rejected (nothing is captured until a vault is set).
export type SecondBrainSetup = {
  step: 'scanning' | 'pick' | 'confirm' | 'rejected'
  candidates: SecondBrainCandidate[]
  vault?: string
  warnings?: string[]
  // Haiku's one-line opinion of the chosen folder, a message about the last typed path, and whether to read everywhere.
  hint?: string
  error?: string
  anywhere?: boolean
  roots: SecondBrainRootChoice[]
}

declare module 'claude-code' {
  interface PluginState {
    'second-brain': {
      current: SecondBrainCurrent | null
      pending: SecondBrainBatch | null
      queue: SecondBrainBatch[]
      running: SecondBrainRunning | null
      saves: SecondBrainSave[]
      paused: boolean
      setup: SecondBrainSetup | null
      idleAt: number | null
      tick: number
      lastRun: { at: number; outcome: 'saved' | 'nothing' | 'skipped' | 'failed' } | null
    }
  }
}
