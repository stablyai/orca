// What a structured provider said about its child work, in the child-work vocabulary.
//
// A producer decodes provider frames into these edges and the host folds them into the one
// record per child it owns. Edges carry facts, not records: which child is live, what it is
// doing, how it ended. Only a child's own ending settles it, or the end of its session.

import type { AgentChildWorkAliasKind } from './agent-status-child-work-alias'
import type {
  AgentChildWorkKind,
  AgentChildWorkOperation,
  AgentChildWorkOutcome,
  AgentChildWorkResidency,
  AgentChildWorkState
} from './agent-status-child-work'

/** How the provider names one child. `id` is the stable handle today's wire already publishes
 *  (a Claude task id); `runId` names the current run when the provider mints one per run (the
 *  spawn call), and a different one is the provider starting the child again. */
export type AgentChildWorkEvidenceHandle = {
  idKind: Extract<AgentChildWorkAliasKind, 'task_id' | 'thread_id'>
  id: string
  runId?: string
}

/** A child the provider reports live, with every descriptive fact the producer holds for it, so
 *  an edge the host could not admit is healed by the child's next one. */
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

/** A child's own tool traffic: the call it has open now, or that none is open any more. Applies
 *  only to a child already recorded live; it never creates one. */
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

/** The provider session is gone: a child still live can no longer end on its own, so it settles
 *  with an outcome nobody reported. Settled children stay; the parent's removal drops them. */
export type AgentChildWorkSessionEndedEvidence = { type: 'session-ended'; observedAt: number }

export type AgentChildWorkEvidence =
  | AgentChildWorkLiveEvidence
  | AgentChildWorkOperationEvidence
  | AgentChildWorkEndedEvidence
  | AgentChildWorkSessionEndedEvidence
