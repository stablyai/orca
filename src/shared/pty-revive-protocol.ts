import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { AgentSessionOwnerBinding } from './agent-session-host-authority'
import type { TuiAgent } from './types'

export const RELAY_PTY_REVIVE_OUTCOME_VERSION = 1 as const
export const MAX_RELAY_PTY_REVIVE_OUTCOME_BYTES = 8 * 1024 * 1024
export const MAX_RELAY_PTY_REVIVE_ENTRIES = 50

export type RelayPtyReplayTail = {
  data: string
  encoding: 'utf8'
  byteLength: number
  truncated: boolean
}

export type RelayPtyDurableLaunch = {
  startupCommand?: string
  shellOverride?: string
  launchAgent?: TuiAgent
  startedAt?: number
}

export type RelayPtyRevivedEntry = {
  id: string
  disposition: 'replacement-spawned' | 'already-managed'
  incarnationId: string
  paneKey?: string
  tabId?: string
}

export type RelayPtyLostEntry = {
  id: string
  kind: 'recognized-worker' | 'ordinary-shell' | 'unclassified'
  reason: 'worker-replacement-forbidden' | 'process-not-running' | 'pty-runtime-unavailable'
  pid: number
  sourceIncarnationId?: string
  cols: number
  rows: number
  cwd: string
  paneKey?: string
  tabId?: string
  attachIdentity?: { paneKey?: string; tabId?: string }
  worktreeId?: string
  terminalHandle?: string
  replayTail?: RelayPtyReplayTail
  durableLaunch?: RelayPtyDurableLaunch
  agentOwners?: AgentSessionOwnerBinding[]
  providerSession?: AgentProviderSessionMetadata
  orchestrationTaskId?: string
}

export type RelayPtyReviveDiagnostic = {
  code: 'legacy-state' | 'entry-already-pending' | 'entry-invalid' | 'state-budget-reduced'
  id?: string
}

export type RelayPtyReviveOutcomeV1 = {
  outcomeVersion: typeof RELAY_PTY_REVIVE_OUTCOME_VERSION
  revived: RelayPtyRevivedEntry[]
  lost: RelayPtyLostEntry[]
  diagnostics: RelayPtyReviveDiagnostic[]
}

export type PtyReviveResult =
  | { mode: 'typed'; outcome: RelayPtyReviveOutcomeV1 }
  | { mode: 'legacy'; diagnosticCode: 'pty-revive-outcome-unavailable' }
  | { mode: 'not-applicable' }

export { normalizeRelayPtyReviveOutcome } from './pty-revive-outcome-normalization'
