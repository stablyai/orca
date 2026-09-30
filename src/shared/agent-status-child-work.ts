import { agentStatusSubjectsEqual, type AgentStatusSubject } from './agent-status-subject'

export const AGENT_CHILD_WORK_KINDS = [
  'agent',
  'workflow',
  'command',
  'monitor',
  'unknown'
] as const
export const AGENT_CHILD_WORK_STATES = [
  'working',
  'monitoring',
  'waiting',
  'blocked',
  'done',
  'idle',
  'unverifiable'
] as const
export const AGENT_CHILD_WORK_MEMBERSHIPS = ['live', 'settled'] as const
export const AGENT_CHILD_WORK_OUTCOMES = ['succeeded', 'failed', 'cancelled', 'unknown'] as const
export const AGENT_CHILD_WORK_INVOCATION_HISTORY_MAX = 32
export const AGENT_CHILD_WORK_RESIDENCIES = ['foreground', 'background'] as const
export const AGENT_CHILD_WORK_OPERATION_BASES = ['open', 'reported'] as const
export const AGENT_CHILD_WORK_LAST_MESSAGE_MAX_LENGTH = 512
export const AGENT_CHILD_WORK_LABEL_MAX_LENGTH = 512
export const AGENT_CHILD_WORK_DESCRIPTION_MAX_LENGTH = 8_000

export type AgentChildWorkId = string
export type AgentChildWorkKind = (typeof AGENT_CHILD_WORK_KINDS)[number]
export type AgentChildWorkState = (typeof AGENT_CHILD_WORK_STATES)[number]
export type AgentChildWorkMembership = (typeof AGENT_CHILD_WORK_MEMBERSHIPS)[number]
export type AgentChildWorkOutcome = (typeof AGENT_CHILD_WORK_OUTCOMES)[number]
/** Whether the provider asserted the child may outlive the turn that launched it. */
export type AgentChildWorkResidency = (typeof AGENT_CHILD_WORK_RESIDENCIES)[number]
/** `open`: a start edge was seen and no end yet. `reported`: the provider's latest heartbeat
 *  named it; no end edge will come, so the next report or the settlement replaces it. */
export type AgentChildWorkOperationBasis = (typeof AGENT_CHILD_WORK_OPERATION_BASES)[number]

/** What the child is doing now, in the vocabulary a hook-reported row uses for its own tool. */
export type AgentChildWorkOperation = {
  toolName: string
  /** One-line preview, the same text a status row carries as `toolInput`. */
  input?: string
  basis: AgentChildWorkOperationBasis
  observedAt: number
}

export type AgentChildWorkInvocationFence = {
  invocationId: string
  generation: number
}

export type AgentChildWorkInvocationHistory = {
  fence: AgentChildWorkInvocationFence
  outcome?: AgentChildWorkOutcome
  settledAt?: number
}

export type AgentChildWorkProviderTiming = {
  startedAt?: number
  completedAt?: number
}

export type AgentChildWorkProvenance = {
  source: 'hook' | 'structured-session' | 'restore' | 'transport'
  producerId: string
}

export type AgentChildWorkInput = {
  childWorkId: AgentChildWorkId
  parent: AgentStatusSubject
  provider: string
  kind: AgentChildWorkKind
  state: AgentChildWorkState
  membership: AgentChildWorkMembership
  outcome?: AgentChildWorkOutcome
  name?: string
  description?: string
  agentType?: string
  model?: string
  totalTokens?: number
  providerTiming?: AgentChildWorkProviderTiming
  /** The child that owns this invocation (a nested agent's spawner, or the agent that launched a
   *  shell). Absent means the session's main agent owns it. */
  parentChildWorkId?: AgentChildWorkId
  /** Host-only: settlement consults it; never projected to a view. */
  residency?: AgentChildWorkResidency
  /** Only while live and working, waiting or blocked. */
  operation?: AgentChildWorkOperation
  /** Newest thing the child said; `outcome` says whether it is a result or an error. */
  lastMessage?: string
  firstObservedAt: number
  /** The child's own evidence clock: the last time the host admitted evidence for it. */
  observedAt: number
  /** Host time the current invocation settled. Stamped by admission, never by a producer. */
  settledAt?: number
  stoppable: boolean
  invocation: AgentChildWorkInvocationFence
  previousInvocations?: AgentChildWorkInvocationHistory[]
  provenance: AgentChildWorkProvenance
}

export type AgentChildWorkRecord = AgentChildWorkInput & {
  revision: number
}

export function agentChildWorkFencesEqual(
  left: AgentChildWorkInvocationFence,
  right: AgentChildWorkInvocationFence
): boolean {
  return left.invocationId === right.invocationId && left.generation === right.generation
}

export function agentChildWorkBelongsTo(
  child: Pick<AgentChildWorkInput, 'parent'>,
  parent: AgentStatusSubject
): boolean {
  return agentStatusSubjectsEqual(child.parent, parent)
}
