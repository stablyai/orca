// Structured provider task state, decoded into the canonical child-work vocabulary.
//
// The input is the adapter's FULL roster — live tasks, settled tasks, usage and stop
// capability. The status summary is not an ingest source: it keeps only live `tasks`,
// strips `totalTokens` and omits an empty list, so no decoder could recover settled
// history or usage from it.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from './agent-session-background-task-wire'
import type {
  AgentChildWorkKind,
  AgentChildWorkMembership,
  AgentChildWorkProviderTiming,
  AgentChildWorkState
} from './agent-status-child-work'

/** Alias segment for every structured background task, so a task id is scoped by
 *  parent subject and provider alone. A different producer observing the same work
 *  uses its own segment and needs positive evidence before the two may be joined. */
export const STRUCTURED_CHILD_WORK_SEGMENT_ID = 'structured-background-tasks'
export const STRUCTURED_CHILD_WORK_PRODUCER_ID = 'structured-background-tasks'

/** Named ingestion bound, sized to the provider trackers' own retention. */
export const STRUCTURED_CHILD_WORK_MAX_TASKS = 256

/** Matches the background projection's provider-id bound and the alias part bound. */
const PROVIDER_TASK_ID_MAX_LENGTH = 512
const LABEL_MAX_LENGTH = 512
const DESCRIPTION_MAX_LENGTH = 8_000

export type StructuredChildWorkObservation = {
  providerTaskId: string
  kind: AgentChildWorkKind
  state: AgentChildWorkState
  membership: AgentChildWorkMembership
  name?: string
  description?: string
  totalTokens?: number
  providerTiming?: AgentChildWorkProviderTiming
  stoppable: boolean
}

export type StructuredChildWorkEvidence = {
  observations: StructuredChildWorkObservation[]
  supportsTaskStop: boolean
  supportsStopAll: boolean
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return undefined
  }
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      return undefined
    }
  }
  return trimmed
}

function usageTotalTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function providerTiming(value: unknown): AgentChildWorkProviderTiming | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? { startedAt: value }
    : undefined
}

/** The strip's own fallback for a host that reports no per-task state
 *  (`background-task-roster.ts` `effectiveState`), applied once here so the
 *  canonical record carries a state both surfaces already agree on. */
export function structuredChildWorkState(
  task: Pick<AgentSessionBackgroundTask, 'kind' | 'state'>,
  settled: boolean
): AgentChildWorkState {
  if (task.state) {
    return task.state
  }
  if (settled) {
    return 'done'
  }
  return task.kind === 'monitor' ? 'monitoring' : 'working'
}

function observe(
  task: AgentSessionBackgroundTask,
  settled: boolean,
  supportsTaskStop: boolean
): StructuredChildWorkObservation | null {
  const providerTaskId = boundedText(task.id, PROVIDER_TASK_ID_MAX_LENGTH)
  if (!providerTaskId) {
    return null
  }
  const name = boundedText(task.name, LABEL_MAX_LENGTH)
  const description = boundedText(task.description, DESCRIPTION_MAX_LENGTH)
  const totalTokens = usageTotalTokens(task.totalTokens)
  const timing = providerTiming(task.startedAt)
  return {
    providerTaskId,
    kind: task.kind,
    state: structuredChildWorkState(task, settled),
    membership: settled ? 'settled' : 'live',
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(timing !== undefined ? { providerTiming: timing } : {}),
    // A positive host assertion, never absence: only the Claude adapter implements
    // `stopBackgroundTasks`, and a row nothing can target must refuse its own stop.
    stoppable: !settled && supportsTaskStop && task.stoppable !== false
  }
}

/**
 * Decode one adapter roster. `null` is the provider's authoritative "no live work"
 * and reconciles to an empty roster; `undefined` — no such session — is absence of
 * evidence and is not decoded at all.
 */
export function decodeStructuredChildWorkEvidence(
  state: AgentSessionBackgroundTaskState | null
): StructuredChildWorkEvidence {
  const supportsTaskStop = state?.supportsTaskStop === true
  const observations: StructuredChildWorkObservation[] = []
  const seen = new Set<string>()
  // Live last: a provider that reports one id in both rosters is stating it is live.
  for (const [roster, settled] of [
    [state?.settledTasks, true],
    [state?.tasks, false]
  ] as const) {
    for (const task of roster ?? []) {
      const observation = observe(task, settled, supportsTaskStop)
      if (!observation) {
        continue
      }
      if (seen.has(observation.providerTaskId)) {
        const index = observations.findIndex(
          (candidate) => candidate.providerTaskId === observation.providerTaskId
        )
        observations[index] = observation
        continue
      }
      if (observations.length >= STRUCTURED_CHILD_WORK_MAX_TASKS) {
        continue
      }
      seen.add(observation.providerTaskId)
      observations.push(observation)
    }
  }
  return {
    observations,
    supportsTaskStop,
    // Absent means supported on this wire; the host says `false` when its provider
    // exposes no honest stop-all.
    supportsStopAll: state ? state.supportsStopAll !== false : false
  }
}
