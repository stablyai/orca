import { launchStateLifecycle } from './structured-agent-session-launch-lifecycle'
import { forgetStructuredSessionSelection } from '../options/structured-agent-session-selection-controller'
import { useSyncExternalStore } from 'react'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { StructuredLaunchFailure } from './structured-agent-session-launch-failure'
import type {
  StructuredAgentSessionForkSource,
  StructuredAgentSessionResumeSource
} from '../../../../../shared/agent-session/structured-agent-session-create'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../../shared/execution-host'
import type { StructuredLaunchRecoveryState } from './structured-agent-session-launch-recovery'
import type { StructuredLaunchSelection } from './structured-agent-session-launch-options'
import type {
  StructuredAgentLaunchOptions,
  StructuredLaunchCallerGroup
} from './structured-agent-session-launch-callers'
import {
  deleteStructuredAgentLaunchRecord,
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  readStructuredAgentLaunchRecord,
  updateStructuredAgentLaunchRecords,
  writeStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'
import {
  type StructuredAgentLaunchPersistedRecord,
  structuredAgentLaunchRecordFor
} from './structured-agent-session-launch-record'
import {
  resetStructuredAgentLaunchCancellationForTests,
  retireAbsentStructuredAgentLaunchCancellations,
  retireStructuredAgentLaunchCancellation
} from '../../launch-cancel-tombstones-compat/structured-agent-session-launch-cancellation'
import { resetStructuredAgentLocalLaunchCancelsForTests } from './structured-agent-session-local-launch-cancel'

export type StructuredLaunchState = StructuredLaunchRecoveryState & {
  identity: string
  /** Fixed by the caller that opened this launch so coalesced prompts use one delivery mode. */
  promptDelivery: StructuredAgentLaunchOptions['promptDelivery']
  callers: StructuredLaunchCallerGroup
  /** The host's refusal behind the last failed attempt, worded beside Retry. Absent when the
   *  failure named none. */
  failure?: StructuredLaunchFailure
  selection: StructuredLaunchSelection
  /** A host list showed the chat, so its create reply needs no protection from older lists. */
  hostListed?: true
  /** The bounded caller finished; this identity may still observe exact late evidence. */
  operationEnded?: true
}

export type StructuredAgentLaunchStatus = 'idle' | 'pending' | 'unknown'
export type StructuredAgentSessionLaunchLifecycle =
  | 'pending'
  | 'visibility-unknown'
  | 'failed'
  | 'published'
  | 'cancelled'

const structuredLaunchesBySessionId = new Map<string, StructuredLaunchState>()
/** Null when the writer can't name its sessions, so subscribers re-read every launch. */
type StructuredLaunchListener = (sessionIds: readonly string[] | null) => void
const structuredLaunchListeners = new Set<StructuredLaunchListener>()

export function resetStructuredAgentLaunchRegistryForTests(): void {
  for (const sessionId of structuredLaunchesBySessionId.keys()) {
    forgetStructuredSessionSelection(sessionId)
  }
  structuredLaunchesBySessionId.clear()
  structuredLaunchListeners.clear()
  resetStructuredAgentLaunchCancellationForTests()
  resetStructuredAgentLocalLaunchCancelsForTests()
}

export function notifyStructuredLaunchListeners(sessionIds?: string | readonly string[]): void {
  function* changes(): Generator<readonly [string, StructuredAgentLaunchPersistedRecord | null]> {
    for (const state of structuredLaunchesBySessionId.values()) {
      yield [state.intent.sessionId, structuredLaunchRecord(state)]
    }
  }
  updateStructuredAgentLaunchRecords(changes())
  publishStructuredLaunchChange(sessionIds)
}

export function publishStructuredLaunchChange(sessionIds?: string | readonly string[]): void {
  const changed = typeof sessionIds === 'string' ? [sessionIds] : (sessionIds ?? null)
  for (const listener of structuredLaunchListeners) {
    listener(changed)
  }
}

export function subscribeStructuredAgentLaunchStatus(
  listener: StructuredLaunchListener
): () => void {
  structuredLaunchListeners.add(listener)
  return () => structuredLaunchListeners.delete(listener)
}

// Key by agent for concurrent Claude/Codex starts, and conversation so resumes never join unrelated blank launches.
export function structuredLaunchIdentity(
  worktreeId: string,
  agent: TuiAgent,
  scope: {
    resumeFrom?: StructuredAgentSessionResumeSource
    forkFrom?: StructuredAgentSessionForkSource
    executionHostId?: string
  } = {}
): string {
  const { resumeFrom, forkFrom, executionHostId = LOCAL_EXECUTION_HOST_ID } = scope
  if (forkFrom) {
    return `${agent}:${worktreeId}:fork:${executionHostId}:${forkFrom.sessionId}:${forkFrom.throughItemId}`
  }
  // A conversation id names a transcript on one host; never join a resume running on another.
  return resumeFrom
    ? `${agent}:${worktreeId}:resume:${executionHostId}:${resumeFrom.providerSessionId}`
    : `${agent}:${worktreeId}`
}

export function getStructuredLaunchStateBySessionId(
  sessionId: string
): StructuredLaunchState | undefined {
  return structuredLaunchesBySessionId.get(sessionId)
}

export function setStructuredLaunchState(state: StructuredLaunchState): void {
  structuredLaunchesBySessionId.set(state.intent.sessionId, state)
  persistStructuredLaunchState(state)
}

export function deleteStructuredLaunchStateIfCurrent(state: StructuredLaunchState): boolean {
  if (structuredLaunchesBySessionId.get(state.intent.sessionId) !== state) {
    return false
  }
  structuredLaunchesBySessionId.delete(state.intent.sessionId)
  deleteStructuredAgentLaunchRecord(state.intent.sessionId)
  return true
}

function persistStructuredLaunchState(state: StructuredLaunchState): void {
  const record = structuredLaunchRecord(state)
  if (record) {
    writeStructuredAgentLaunchRecord(record)
  } else {
    deleteStructuredAgentLaunchRecord(state.intent.sessionId)
  }
}

function structuredLaunchRecord(
  state: StructuredLaunchState
): StructuredAgentLaunchPersistedRecord | null {
  const lifecycle = launchStateLifecycle(state)
  if (lifecycle === 'published' || lifecycle === 'cancelled') {
    return null
  }
  return {
    ...structuredAgentLaunchRecordFor(state.intent, lifecycle),
    ...(lifecycle === 'failed' ? { failedAt: state.callers.failedAt } : {})
  }
}

export function getPersistedStructuredAgentLaunchRecord(
  sessionId: string
): StructuredAgentLaunchPersistedRecord | undefined {
  return readStructuredAgentLaunchRecord(sessionId)
}

export function structuredLaunchStates(): IterableIterator<StructuredLaunchState> {
  return structuredLaunchesBySessionId.values()
}

export function getStructuredAgentSessionLaunchLifecycle(
  worktreeId: string,
  sessionId: string
): StructuredAgentSessionLaunchLifecycle | null {
  if (hasStructuredAgentSessionLaunchCancellationTombstone(worktreeId, sessionId)) {
    return 'cancelled'
  }
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (state?.intent.worktreeId === worktreeId) {
    return launchStateLifecycle(state)
  }
  return getPersistedStructuredAgentLaunchRecord(sessionId)?.lifecycle ?? null
}

export {
  getStructuredAgentSessionLaunchResumes,
  structuredAgentSessionLaunchHasRetainedInput,
  settleStructuredLaunchFirstMessageFromJournal
} from './structured-agent-session-launch-input'

/** The host a launch still owed an outcome was sent to, in memory or persisted across a reload. */
export function getStructuredAgentSessionLaunchOwner(
  sessionId: string
): ExecutionHostId | undefined {
  return (
    getStructuredLaunchStateBySessionId(sessionId)?.intent.executionHostId ??
    getPersistedStructuredAgentLaunchRecord(sessionId)?.executionHostId
  )
}

export function getStructuredAgentSessionLaunchFailure(
  worktreeId: string,
  sessionId: string
): StructuredLaunchFailure | null {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state || state.intent.worktreeId !== worktreeId) {
    return null
  }
  const lifecycle = launchStateLifecycle(state)
  return lifecycle === 'failed' ||
    (lifecycle === 'visibility-unknown' && !!state.intent.params.firstMessage)
    ? (state.failure ?? null)
    : null
}

export function useStructuredAgentSessionLaunchFailure(
  worktreeId: string,
  sessionId: string
): StructuredLaunchFailure | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchFailure(worktreeId, sessionId),
    () => null
  )
}

export function useStructuredAgentSessionLaunchLifecycle(
  worktreeId: string,
  sessionId: string
): StructuredAgentSessionLaunchLifecycle | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId),
    () => null
  )
}

export function shouldRetainStructuredAgentSessionLaunchTab(
  worktreeId: string,
  sessionId: string
): boolean {
  const lifecycle = getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId)
  return lifecycle === 'pending' || lifecycle === 'visibility-unknown' || lifecycle === 'failed'
}

export function hasStructuredAgentSessionLaunchCancellationTombstone(
  _worktreeId: string,
  sessionId: string
): boolean {
  return hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId)
}

export function retireStructuredAgentSessionLaunchCancellationTombstone(
  worktreeId: string,
  sessionId: string
): boolean {
  if (!hasStructuredAgentSessionLaunchCancellationTombstone(worktreeId, sessionId)) {
    return false
  }
  retireStructuredAgentLaunchCancellation(sessionId)
  notifyStructuredLaunchListeners(sessionId)
  return true
}

export function retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
  publishedSessionIds: ReadonlySet<string>,
  authoritativeInventory: number,
  executionHostId: ExecutionHostId
): boolean {
  const retired = retireAbsentStructuredAgentLaunchCancellations(
    publishedSessionIds,
    authoritativeInventory,
    executionHostId
  )
  if (retired.length) {
    notifyStructuredLaunchListeners(retired)
  }
  return retired.length > 0
}
