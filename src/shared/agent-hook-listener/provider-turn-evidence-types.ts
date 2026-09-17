import type { AgentHookSource } from '../agent-hook-relay'
import type { ParsedAgentStatusPayload } from '../agent-status-types'

export type ProviderTurnOutcome = 'completed' | 'failed' | 'interrupted'
export type ProviderWorkKind = 'joined-child' | 'resident-background'

export type ProviderTurnInventoryWork = {
  workId: string
  kind: ProviderWorkKind
  phase: 'active' | 'settled' | 'unresolved'
  outcome?: ProviderTurnOutcome
  startedAt?: number
  settledAt?: number
}

export type ProviderCurrentTurnInventory = {
  turnId: string
  startedAt?: number
  joinedChildren: ProviderTurnInventoryWork[]
  residentBackground: ProviderTurnInventoryWork[]
}

export type ProviderTurnEvidence = {
  source: AgentHookSource
  producerId: string
  eventId: string
  observedAt: number
  kind:
    | 'turn-started'
    | 'turn-outcome-observed'
    | 'turn-interrupt-acknowledged'
    | 'work-started'
    | 'work-outcome-observed'
    | 'current-turn-inventory'
  turnId?: string
  outcome?: ProviderTurnOutcome
  recordKind?: 'event' | 'terminal-record'
  workId?: string
  workKind?: ProviderWorkKind
  /** `null` is a complete answer that no foreground turn exists. */
  inventory?: ProviderCurrentTurnInventory | null
}

export type ProviderTurnEvidenceRead = {
  evidence: ProviderTurnEvidence[]
  /** Why no semantic event was emitted. Useful for diagnostics and conformance fixtures. */
  ignored?: 'anonymous-outcome' | 'session-boundary' | 'incomplete-inventory' | 'unsupported'
}

export type ProviderTurnEvidenceInput = {
  event: {
    source?: AgentHookSource
    paneKey: string
    hookEventName?: string
    providerPromptId?: string
    toolAgentId?: string
    toolAgentType?: string
    payload: ParsedAgentStatusPayload
    /** A provider turn key extracted from a provider payload when it is not prompt_id. */
    providerTurnId?: string
    /** Provider explicitly marked this event as the terminal turn boundary. */
    providerTurnTerminal?: boolean
    /** A complete provider inventory, when the adapter can query one. */
    currentTurnInventory?: ProviderCurrentTurnInventory | null
    /** True only when the inventory enumerates the provider's complete current state. */
    currentTurnInventoryComplete?: boolean
    /** Background work known to outlive the foreground turn. */
    residentBackgroundWorkIds?: readonly string[]
  }
  observedAt?: number
}

export type ProviderInterruptEvidenceInput = {
  source: AgentHookSource
  paneKey: string
  turnId?: string
  observedAt?: number
  /** Input acceptance is deliberately not accepted here; this is a provider ack only. */
  acknowledgedBy: 'provider-hook' | 'provider-record'
}

export type ProviderTerminalTurnRecordInput = {
  source: AgentHookSource
  paneKey: string
  runId: string
  executionId: string
  record: unknown
  observedAt?: number
}
