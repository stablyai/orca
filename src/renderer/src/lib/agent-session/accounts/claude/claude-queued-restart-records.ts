import type { AgentProviderSessionMetadata } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'

/** One switch's lookups by pane key; null marks a pane looked up with nothing found. */
export type ClaudePaneLookups = ReadonlyMap<string, AgentProviderSessionMetadata | null>

/** What the switch that queued a Claude restart decided for it; held in memory only, never in the store. */
export type QueuedClaudeRestart = {
  restartAll: boolean
  session?: AgentProviderSessionMetadata
}

let records = new Map<string, QueuedClaudeRestart>()

export function recordQueuedClaudeRestarts(
  ptyIds: readonly string[],
  restartAll: boolean,
  sessions: ReadonlyMap<string, AgentProviderSessionMetadata> = new Map()
): void {
  for (const ptyId of ptyIds) {
    const session = sessions.get(ptyId)
    records.set(ptyId, { restartAll, ...(session ? { session } : {}) })
  }
}

export function takeQueuedClaudeRestart(ptyId: string): QueuedClaudeRestart | undefined {
  const record = records.get(ptyId)
  records.delete(ptyId)
  return record
}

export function restoreQueuedClaudeRestart(ptyId: string, record: QueuedClaudeRestart): void {
  records.set(ptyId, record)
}

export function moveQueuedClaudeRestart(fromPtyId: string, toPtyId: string): void {
  const record = records.get(fromPtyId)
  records.delete(fromPtyId)
  records.delete(toPtyId)
  if (record) {
    records.set(toPtyId, record)
  }
}

export function skipsClaudeTurnHold(ptyId: string): boolean {
  return records.get(ptyId)?.restartAll === true
}

export function carriesLookedUpClaudeSession(ptyId: string): boolean {
  return records.get(ptyId)?.session !== undefined
}

export function keepQueuedClaudeRestarts(pending: Readonly<Record<string, string>>): void {
  records = new Map([...records].filter(([ptyId]) => pending[ptyId] === 'claude'))
}
