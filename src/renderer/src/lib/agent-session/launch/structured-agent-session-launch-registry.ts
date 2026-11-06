import { launchStateLifecycle } from '../../structured-agent-session-launch-lifecycle'
import { forgetStructuredSessionSelection } from '../../structured-agent-session-selection-controller'
import { useSyncExternalStore } from 'react'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { StructuredLaunchFailure } from './structured-agent-session-launch-failure'
import type { StructuredAgentSessionResumeSource } from '../../../../../shared/agent-session/structured-agent-session-create'
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
import { hostLaunchAwaitsItsTab } from './structured-agent-session-host-launch-retention'
import { hostLaunchOwesOpening } from './structured-agent-session-launch-opening'
import {
  endHostLaunchObservation,
  resetHostLaunchObserversForTests
} from './structured-agent-session-host-launch-observer'
import { retireHostLaunchSources } from './structured-agent-session-host-launch-sources'

export type StructuredLaunchState = StructuredLaunchRecoveryState & {
  identity: string
  /** Fixed by the caller that opened this launch so coalesced prompts use one delivery mode. */
  promptDelivery: StructuredAgentLaunchOptions['promptDelivery']
  callers: StructuredLaunchCallerGroup
  /** The host's refusal behind the last failed attempt, worded beside Retry. Absent when the
   *  failure named none. */
  failure?: StructuredLaunchFailure
  /** Shown as failed, with Retry, while its live host launch waits for files that could not be
   *  sent; in memory only, so the saved row still reads the launch as it is. */
  parkedFailure?: StructuredLaunchFailure
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
const structuredLaunchListeners = new Set<() => void>()

export function resetStructuredAgentLaunchRegistryForTests(): void {
  for (const sessionId of structuredLaunchesBySessionId.keys()) {
    forgetStructuredSessionSelection(sessionId)
  }
  structuredLaunchesBySessionId.clear()
  structuredLaunchListeners.clear()
  resetHostLaunchObserversForTests()
  resetStructuredAgentLaunchCancellationForTests()
  resetStructuredAgentLocalLaunchCancelsForTests()
}

export function notifyStructuredLaunchListeners(): void {
  function* changes(): Generator<readonly [string, StructuredAgentLaunchPersistedRecord | null]> {
    for (const state of structuredLaunchesBySessionId.values()) {
      yield [state.intent.sessionId, structuredLaunchRecord(state)]
    }
  }
  updateStructuredAgentLaunchRecords(changes())
  publishStructuredLaunchStatus()
}

/** Tells views launch status changed, saving nothing: for a change already saved, or to
 *  tombstones only. Never saves a launch, so it may run where saving one would be wrong. */
export function publishStructuredLaunchStatus(): void {
  for (const listener of structuredLaunchListeners) {
    listener()
  }
}

/** Saves the one launch that changed, then tells views. A launch this window no longer holds (its
 *  row already retired, or replaced) saves nothing, so a late callback can never bring a row back. */
export function notifyStructuredLaunchStateChanged(state: StructuredLaunchState): void {
  notifyStructuredLaunchIntentChanged(state.intent, state)
}

/** As above, for the launch this window holds with exactly this intent. */
export function notifyStructuredLaunchIntentChanged(
  intent: StructuredLaunchState['intent'],
  expected?: StructuredLaunchState
): void {
  const state = structuredLaunchesBySessionId.get(intent.sessionId)
  if (state && state.intent === intent && (!expected || expected === state)) {
    persistStructuredLaunchState(state)
  }
  publishStructuredLaunchStatus()
}

export function subscribeStructuredAgentLaunchStatus(listener: () => void): () => void {
  structuredLaunchListeners.add(listener)
  return () => structuredLaunchListeners.delete(listener)
}

// Key by agent for concurrent Claude/Codex starts, and conversation so resumes never join unrelated blank launches.
export function structuredLaunchIdentity(
  worktreeId: string,
  agent: TuiAgent,
  scope: { resumeFrom?: StructuredAgentSessionResumeSource; executionHostId?: string } = {}
): string {
  const { resumeFrom, executionHostId = LOCAL_EXECUTION_HOST_ID } = scope
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

/** `adoptedElsewhere`: the host's own surface took the launch and nothing is left for its chat. */
export function deleteStructuredLaunchStateIfCurrent(
  state: StructuredLaunchState,
  adoptedElsewhere?: true
): boolean {
  if (
    structuredLaunchesBySessionId.get(state.intent.sessionId) !== state ||
    ((hostLaunchAwaitsItsTab(state) || hostLaunchOwesOpening(state)) && !adoptedElsewhere)
  ) {
    return false
  }
  // Its observation's waits detach first, then the files nothing here can send any more go.
  endHostLaunchObservation(state.intent.sessionId)
  retireHostLaunchSources(state.intent)
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
  // A host launch's chat this window never showed is not the user's yet: a reload redraws it from
  // this row and reads the host again.
  // Nor has one whose opening its host never acknowledged and the composer could not take back.
  const kept =
    lifecycle === 'published' && (hostLaunchAwaitsItsTab(state) || hostLaunchOwesOpening(state))
  if (lifecycle === 'cancelled' || (lifecycle === 'published' && !kept)) {
    return null
  }
  return {
    ...structuredAgentLaunchRecordFor(
      state.intent,
      lifecycle === 'published' ? 'visibility-unknown' : lifecycle
    ),
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
    const lifecycle = launchStateLifecycle(state)
    return lifecycle === 'pending' && state.parkedFailure ? 'failed' : lifecycle
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
  if (lifecycle === 'pending' && state.parkedFailure) {
    return state.parkedFailure
  }
  return lifecycle === 'failed' || (lifecycle === 'visibility-unknown' && !!state.intent.opening)
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
  publishStructuredLaunchStatus()
  return true
}

export function retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
  publishedSessionIds: ReadonlySet<string>,
  authoritativeInventory: number,
  executionHostId: ExecutionHostId
): boolean {
  const changed = retireAbsentStructuredAgentLaunchCancellations(
    publishedSessionIds,
    authoritativeInventory,
    executionHostId
  )
  if (changed) {
    publishStructuredLaunchStatus()
  }
  return changed
}
