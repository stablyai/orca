import type { AgentSessionBackgroundTask } from './agent-session-background-task-wire'
import { AGENT_STATUS_MAX_SUBAGENTS, type AgentSubagentSnapshot } from './agent-status-types'
import { isAgentChildWorkKind } from './agent-status-child-work-liveness'
import type {
  AgentChildWorkKind,
  AgentChildWorkMembership,
  AgentChildWorkState
} from './agent-status-child-work'

const LEGACY_PROVIDER_ID_MAX_LENGTH = 64
const BACKGROUND_PROVIDER_ID_MAX_LENGTH = 512

export type AgentChildWorkLegacyProjectionCandidate = {
  providerId: string
  child: {
    kind: AgentChildWorkKind
    state?: AgentChildWorkState
    membership: AgentChildWorkMembership
    firstObservedAt: number
    name?: string
    description?: string
    agentType?: string
    model?: string
    totalTokens?: number
    stoppable: boolean
  }
}

function legacyProviderId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= LEGACY_PROVIDER_ID_MAX_LENGTH ? trimmed : null
}

function backgroundProviderId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= BACKGROUND_PROVIDER_ID_MAX_LENGTH ? trimmed : null
}

function legacySubagentState(
  state: AgentChildWorkState | undefined
): AgentSubagentSnapshot['state'] | null {
  if (state === undefined || state === 'working' || state === 'monitoring') {
    return 'working'
  }
  if (state === 'done' || state === 'idle') {
    return 'idle'
  }
  if (state === 'waiting' || state === 'blocked' || state === 'unverifiable') {
    return state
  }
  return null
}

/** A host-published background task as a projection candidate: the wire row already
 *  speaks the child-work vocabulary, and a published task is live by definition. */
export function agentChildWorkProjectionCandidateFromBackgroundTask(
  task: AgentSessionBackgroundTask
): AgentChildWorkLegacyProjectionCandidate {
  return {
    providerId: task.id,
    child: {
      kind: task.kind,
      ...(task.state !== undefined ? { state: task.state } : {}),
      membership: 'live',
      firstObservedAt: task.startedAt ?? 0,
      // Truthy, not present: an empty label carries no identity and would beat the
      // `description ?? agentType ?? 'unknown'` fallbacks every child-row reader relies on.
      ...(task.name ? { name: task.name, agentType: task.name } : {}),
      ...(task.description ? { description: task.description } : {}),
      ...(task.totalTokens !== undefined ? { totalTokens: task.totalTokens } : {}),
      stoppable: task.stoppable ?? true
    }
  }
}

export function projectAgentChildWorkLegacySubagents(
  candidates: readonly AgentChildWorkLegacyProjectionCandidate[]
): AgentSubagentSnapshot[] | undefined {
  const projected: AgentSubagentSnapshot[] = []
  for (const candidate of candidates) {
    if (!isAgentChildWorkKind(candidate.child.kind)) {
      continue
    }
    const id = legacyProviderId(candidate.providerId)
    const state = legacySubagentState(candidate.child.state)
    if (
      !id ||
      !state ||
      !Number.isFinite(candidate.child.firstObservedAt) ||
      candidate.child.firstObservedAt < 0
    ) {
      continue
    }
    projected.push({
      id,
      state,
      startedAt: candidate.child.firstObservedAt,
      ...(candidate.child.agentType !== undefined ? { agentType: candidate.child.agentType } : {}),
      ...(candidate.child.model !== undefined ? { model: candidate.child.model } : {}),
      ...(candidate.child.description !== undefined
        ? { description: candidate.child.description }
        : {})
    })
    if (projected.length === AGENT_STATUS_MAX_SUBAGENTS) {
      break
    }
  }
  return projected.length > 0 ? projected : undefined
}

export type AgentChildWorkLegacyBackgroundProjection = {
  tasks?: AgentSessionBackgroundTask[]
  settledTasks?: AgentSessionBackgroundTask[]
}

function projectBackgroundTask(
  candidate: AgentChildWorkLegacyProjectionCandidate
): AgentSessionBackgroundTask | null {
  const id = backgroundProviderId(candidate.providerId)
  if (
    !id ||
    !Number.isFinite(candidate.child.firstObservedAt) ||
    candidate.child.firstObservedAt < 0
  ) {
    return null
  }
  return {
    id,
    kind: candidate.child.kind,
    ...(candidate.child.description !== undefined
      ? { description: candidate.child.description }
      : {}),
    ...(candidate.child.name !== undefined ? { name: candidate.child.name } : {}),
    ...(candidate.child.state !== undefined ? { state: candidate.child.state } : {}),
    startedAt: candidate.child.firstObservedAt,
    ...(candidate.child.totalTokens !== undefined
      ? { totalTokens: candidate.child.totalTokens }
      : {}),
    stoppable: candidate.child.stoppable
  }
}

export function projectAgentChildWorkLegacyBackgroundTasks(
  candidates: readonly AgentChildWorkLegacyProjectionCandidate[]
): AgentChildWorkLegacyBackgroundProjection {
  const tasks: AgentSessionBackgroundTask[] = []
  const settledTasks: AgentSessionBackgroundTask[] = []
  for (const candidate of candidates) {
    const projected = projectBackgroundTask(candidate)
    if (!projected) {
      continue
    }
    if (candidate.child.membership === 'live') {
      tasks.push(projected)
    } else {
      settledTasks.push(projected)
    }
  }
  return {
    ...(tasks.length > 0 ? { tasks } : {}),
    ...(settledTasks.length > 0 ? { settledTasks } : {})
  }
}
