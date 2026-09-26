import type { AgentHookSource } from './agent-hook-relay'
import type {
  AgentStatusExecutionAttachment,
  AgentStatusRunId,
  AgentStatusRunVerdict
} from './agent-status-run'
import type { AgentStatusExecutionScope } from './agent-status-subject'

export type AgentTurnId = string
export type AgentTurnWorkId = string
export type AgentTurnDispatchId = string

export type AgentTurnOwner = AgentStatusExecutionScope & {
  runId: AgentStatusRunId
  attachment: AgentStatusExecutionAttachment
  provider: AgentHookSource
}

export type AgentTurnEvidence = {
  /** Stable within one producer so replay is idempotent. */
  eventId: string
  /** Names the concrete hook, journal, inventory, or host observer. */
  producerId: string
  observedAt: number
  /** Opaque provider cursor retained for diagnostics and recovery handoff. */
  cursor?: string
}

export type AgentTurnOutcome = 'completed' | 'failed' | 'interrupted'
export type AgentTurnPhase = 'active' | 'recovering' | 'settled' | 'unresolved' | 'abandoned'
export type AgentTurnInterruptState = 'none' | 'requested' | 'acknowledged'

export type AgentTurnRecord = {
  turnId: AgentTurnId
  phase: AgentTurnPhase
  outcome: AgentTurnOutcome | null
  /** Whether authoritative inventory closed the finite-child set for this turn. */
  joinedChildrenKnowledge: 'unknown' | 'complete'
  /** Sticky: `integrityIssues` is a bounded diagnostic ring, so a settlement gate
   *  that scanned it would re-open once the entry aged out. */
  integrityBreached: boolean
  interrupt: AgentTurnInterruptState
  /** Writing Escape/Ctrl+C is delivery evidence, not an interrupt acknowledgement. */
  interruptInputWrittenAt: number | null
  startedAt: number | null
  settledAt: number | null
  lastEvidence: AgentTurnEvidence
}

export type AgentTurnWorkKind = 'joined-child' | 'resident-background'

export type AgentTurnWorkRecord = {
  turnId: AgentTurnId
  workId: AgentTurnWorkId
  kind: AgentTurnWorkKind
  phase: Exclude<AgentTurnPhase, 'recovering'>
  outcome: AgentTurnOutcome | null
  startedAt: number | null
  settledAt: number | null
  lastEvidence: AgentTurnEvidence
}

export type AgentTurnDispatchReceipt = 'unobserved' | 'received' | 'rejected'
export type AgentTurnDispatchOutcome = AgentTurnOutcome | 'unresolved' | 'abandoned'

export type AgentTurnDispatchRecord = {
  dispatchId: AgentTurnDispatchId
  turnId: AgentTurnId
  receipt: AgentTurnDispatchReceipt
  outcome: AgentTurnDispatchOutcome | null
  settledAt: number | null
  lastEvidence: AgentTurnEvidence
}

export type AgentTurnRecoveryCustody = {
  custodyId: string
  turnId: AgentTurnId
  deadlineAt: number
  lastEvidence: AgentTurnEvidence
}

export type AgentTurnIntegrityIssue = {
  kind: 'capacity-overflow' | 'conflicting-outcome' | 'conflicting-dispatch-turn'
  turnId?: AgentTurnId
  workId?: AgentTurnWorkId
  dispatchId?: AgentTurnDispatchId
  observedAt: number
}

export type AgentTurnAppliedEvent = Pick<AgentTurnEvidence, 'producerId' | 'eventId'>

export type AgentTurnLifecycleState = {
  /** Host-owned projection; structured session journals remain their durable source. */
  version: 1
  owner: AgentTurnOwner
  currentTurnId: AgentTurnId | null
  turns: AgentTurnRecord[]
  work: AgentTurnWorkRecord[]
  dispatches: AgentTurnDispatchRecord[]
  recoveries: AgentTurnRecoveryCustody[]
  executionVerdict: AgentStatusRunVerdict
  integrityIssues: AgentTurnIntegrityIssue[]
  appliedEvents: AgentTurnAppliedEvent[]
}

export type AgentTurnInventoryWork = {
  workId: AgentTurnWorkId
  phase: 'active' | 'settled' | 'unresolved'
  outcome?: AgentTurnOutcome
  startedAt?: number
  settledAt?: number
}

export type AgentCurrentTurnInventory = {
  /** A complete host inventory can re-derive active work and resolve omissions as unknown. */
  turnId: AgentTurnId
  startedAt?: number
  joinedChildren: AgentTurnInventoryWork[]
  residentBackground: AgentTurnInventoryWork[]
}

type AgentTurnEventBase = {
  owner: AgentTurnOwner
  evidence: AgentTurnEvidence
}

export type AgentTurnLifecycleEvent =
  | (AgentTurnEventBase & { kind: 'turn-started'; turnId: AgentTurnId; startedAt?: number })
  | (AgentTurnEventBase & {
      kind: 'turn-outcome-observed'
      turnId: AgentTurnId
      outcome: Exclude<AgentTurnOutcome, 'interrupted'>
      settledAt?: number
      recordKind: 'event' | 'terminal-record'
    })
  | (AgentTurnEventBase & { kind: 'turn-interrupt-requested'; turnId: AgentTurnId })
  | (AgentTurnEventBase & {
      kind: 'turn-interrupt-input-written'
      turnId: AgentTurnId
      writtenAt?: number
    })
  | (AgentTurnEventBase & {
      kind: 'turn-interrupt-acknowledged'
      turnId: AgentTurnId
      settledAt?: number
    })
  | (AgentTurnEventBase & {
      kind: 'work-started'
      turnId: AgentTurnId
      workId: AgentTurnWorkId
      workKind: AgentTurnWorkKind
      startedAt?: number
    })
  | (AgentTurnEventBase & {
      kind: 'work-outcome-observed'
      turnId: AgentTurnId
      workId: AgentTurnWorkId
      workKind: AgentTurnWorkKind
      outcome: AgentTurnOutcome
      settledAt?: number
    })
  | (AgentTurnEventBase & {
      kind: 'current-turn-inventory'
      complete: true
      currentTurn: AgentCurrentTurnInventory | null
    })
  | (AgentTurnEventBase & {
      kind: 'turn-recovery-started'
      turnId: AgentTurnId
      custodyId: string
      deadlineAt: number
    })
  | (AgentTurnEventBase & {
      kind: 'turn-recovery-expired'
      turnId: AgentTurnId
      custodyId: string
    })
  | (AgentTurnEventBase & {
      kind: 'turn-recovery-abandoned'
      turnId: AgentTurnId
      custodyId: string
    })
  | (AgentTurnEventBase & {
      kind: 'execution-verdict-observed'
      verdict: AgentStatusRunVerdict
    })
  | (AgentTurnEventBase & {
      kind: 'dispatch-associated'
      dispatchId: AgentTurnDispatchId
      turnId: AgentTurnId
    })
  | (AgentTurnEventBase & {
      kind: 'dispatch-received'
      dispatchId: AgentTurnDispatchId
      turnId: AgentTurnId
    })
  | (AgentTurnEventBase & {
      kind: 'dispatch-rejected'
      dispatchId: AgentTurnDispatchId
      turnId: AgentTurnId
    })
  | (AgentTurnEventBase & {
      kind: 'dispatch-abandoned'
      dispatchId: AgentTurnDispatchId
      turnId: AgentTurnId
    })

export type AgentTurnCommittedOutcome = {
  completionId: string
  turnId: AgentTurnId
  outcome: AgentTurnOutcome
}

export type AgentTurnCommittedDispatch = {
  settlementId: string
  dispatchId: AgentTurnDispatchId
  turnId: AgentTurnId
  outcome: AgentTurnDispatchOutcome
}

export type AgentTurnLifecycleReduction = {
  state: AgentTurnLifecycleState
  disposition: 'accepted' | 'duplicate' | 'ignored'
  reason?: 'invalid-event' | 'owner-mismatch' | 'capacity' | 'conflict' | 'stale'
  committedOutcomes: AgentTurnCommittedOutcome[]
  committedDispatches: AgentTurnCommittedDispatch[]
}
