import type { AgentSessionBackgroundTask } from './agent-session-background-task-wire'
import { AGENT_STATUS_MAX_SUBAGENTS, type AgentSubagentSnapshot } from './agent-status-types'
import { isAgentChildWorkKind } from './agent-status-child-work-liveness'
import type { AgentChildWorkOutcome, AgentChildWorkState } from './agent-status-child-work'
import type { AgentChildWorkView } from './agent-status-child-work-view'

const LEGACY_PROVIDER_ID_MAX_LENGTH = 64
const BACKGROUND_PROVIDER_ID_MAX_LENGTH = 512

/** Anything a legacy wire shape can be derived from. Every `AgentChildWorkView` is one, so the
 *  old and new shapes cannot disagree; so is a published background task (its state optional,
 *  because an old host sends none). */
export type AgentChildWorkLegacyProjectionCandidate = Pick<
  AgentChildWorkView,
  'kind' | 'membership' | 'firstObservedAt' | 'stoppable'
> &
  Partial<
    Pick<
      AgentChildWorkView,
      | 'providerId'
      | 'state'
      | 'outcome'
      | 'name'
      | 'description'
      | 'agentType'
      | 'model'
      | 'totalTokens'
    >
  >

// The run state today's hosts publish for a settled task, so an old strip reads a settled view
// exactly as it reads a settled task now (an unreadable terminal status settles as `done`).
const LEGACY_SETTLED_RUN_STATE: Record<AgentChildWorkOutcome, AgentChildWorkState> = {
  succeeded: 'done',
  failed: 'blocked',
  cancelled: 'idle',
  unknown: 'done'
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

export function projectAgentChildWorkLegacySubagents(
  candidates: readonly AgentChildWorkLegacyProjectionCandidate[]
): AgentSubagentSnapshot[] | undefined {
  const projected: AgentSubagentSnapshot[] = []
  for (const candidate of candidates) {
    // The legacy roster lists live subagents only; a settled child was never published there.
    if (!isAgentChildWorkKind(candidate.kind) || candidate.membership !== 'live') {
      continue
    }
    const id = legacyProviderId(candidate.providerId)
    const state = legacySubagentState(candidate.state)
    if (
      !id ||
      !state ||
      !Number.isFinite(candidate.firstObservedAt) ||
      candidate.firstObservedAt < 0
    ) {
      continue
    }
    projected.push({
      id,
      state,
      startedAt: candidate.firstObservedAt,
      ...(candidate.agentType !== undefined ? { agentType: candidate.agentType } : {}),
      ...(candidate.model !== undefined ? { model: candidate.model } : {}),
      ...(candidate.description !== undefined ? { description: candidate.description } : {})
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
  if (!id || !Number.isFinite(candidate.firstObservedAt) || candidate.firstObservedAt < 0) {
    return null
  }
  const state =
    candidate.membership === 'settled' && candidate.outcome !== undefined
      ? LEGACY_SETTLED_RUN_STATE[candidate.outcome]
      : candidate.state
  return {
    id,
    kind: candidate.kind,
    ...(candidate.description !== undefined ? { description: candidate.description } : {}),
    ...(candidate.name !== undefined ? { name: candidate.name } : {}),
    ...(state !== undefined ? { state } : {}),
    startedAt: candidate.firstObservedAt,
    ...(candidate.totalTokens !== undefined ? { totalTokens: candidate.totalTokens } : {}),
    stoppable: candidate.stoppable
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
    if (candidate.membership === 'live') {
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
