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

export type AgentChildWorkId = string
export type AgentChildWorkKind = (typeof AGENT_CHILD_WORK_KINDS)[number]
export type AgentChildWorkState = (typeof AGENT_CHILD_WORK_STATES)[number]
export type AgentChildWorkMembership = (typeof AGENT_CHILD_WORK_MEMBERSHIPS)[number]
export type AgentChildWorkOutcome = (typeof AGENT_CHILD_WORK_OUTCOMES)[number]

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
  firstObservedAt: number
  observedAt: number
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
