// Host-internal provider edges patch one record per child, carrying facts instead of records. Only the child's ending or session end settles it.

import type { AgentChildWorkAliasKind } from './agent-status-child-work-alias'
import type {
  AgentChildWorkId,
  AgentChildWorkInvocationFence,
  AgentChildWorkKind,
  AgentChildWorkOperation,
  AgentChildWorkOutcome,
  AgentChildWorkResidency,
  AgentChildWorkState
} from './agent-status-child-work'

/** id is the stable task/thread handle; runId is its spawn-call/turn handle. A different runId starts the child again. */
export type AgentChildWorkEvidenceHandle = {
  idKind: Extract<AgentChildWorkAliasKind, 'task_id' | 'thread_id'>
  id: string
  runId?: string
}

/** Report all known descriptive facts with live evidence so a later edge heals refused admission. */
export type AgentChildWorkLiveObservation = {
  handle: AgentChildWorkEvidenceHandle
  kind: AgentChildWorkKind
  residency: AgentChildWorkResidency
  state: Exclude<AgentChildWorkState, 'done'>
  name?: string
  description?: string
  agentType?: string
  totalTokens?: number
  /** `null`: the operation that was open has ended. Absent: this edge says nothing about it. */
  operation?: AgentChildWorkOperation | null
  lastMessage?: string
  /** Handle id (either alias) of the child that owns this work; absent for the main agent. */
  ownerId?: string
  stoppable: boolean
}

export type AgentChildWorkLiveEvidence = {
  type: 'live'
  observedAt: number
  child: AgentChildWorkLiveObservation
  /** The provider started a child that had ended: a new run, even under the same run handle. */
  restart?: true
}

/** Tool traffic updates recorded live children only, never creates them; null closes the operation. */
export type AgentChildWorkOperationEvidence = {
  type: 'operation'
  observedAt: number
  /** Any handle the child answers to: its stable id, or the spawn call of its run. */
  childId: string
  /** `null`: the call it had open has ended. */
  operation: AgentChildWorkOperation | null
}

/** The child's own terminal frame. `unknown` is an ending whose status the provider did not say. */
export type AgentChildWorkEndedEvidence = {
  type: 'ended'
  observedAt: number
  handle: AgentChildWorkEvidenceHandle
  outcome: AgentChildWorkOutcome
  lastMessage?: string
  totalTokens?: number
}

/** Accepted Stop settles only its captured run provisionally as cancelled/stop-acknowledged unless already ended. Prefer any provider-reported outcome; never settle a later run. */
export type AgentChildWorkStopAcknowledgedEvidence = {
  type: 'stop-acknowledged'
  observedAt: number
  childWorkId: AgentChildWorkId
  /** The provider handle the Stop named, for the host's open-work set, which keys by handle. */
  handleId: string
  invocation: AgentChildWorkInvocationFence
  outcome?: AgentChildWorkOutcome
}

/** The next provider-accepted user send retires settled children, except owners of live descendants at any depth. Provider-initiated turns do not retire them. */
export type AgentChildWorkTurnStartedEvidence = { type: 'turn-started'; observedAt: number }

/** Session loss settles live children with unknown outcome; retain settled records until the next user turn or parent removal. */
export type AgentChildWorkSessionEndedEvidence = { type: 'session-ended'; observedAt: number }

/** Remove work with no ending to report, such as exited commands; it must own no other record. */
export type AgentChildWorkRemovedEvidence = {
  type: 'removed'
  observedAt: number
  handle: AgentChildWorkEvidenceHandle
}

export type AgentChildWorkEvidence =
  | AgentChildWorkLiveEvidence
  | AgentChildWorkOperationEvidence
  | AgentChildWorkEndedEvidence
  | AgentChildWorkRemovedEvidence
  | AgentChildWorkStopAcknowledgedEvidence
  | AgentChildWorkTurnStartedEvidence
  | AgentChildWorkSessionEndedEvidence
