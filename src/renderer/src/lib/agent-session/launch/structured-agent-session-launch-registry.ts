import { useSyncExternalStore } from 'react'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { StructuredLaunchFailure } from '../../structured-agent-session-launch-failure'
import type { StructuredAgentSessionResumeSource } from '../../../../../shared/structured-agent-session-create'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../../shared/execution-host'
import type { StructuredLaunchRecoveryState } from './structured-agent-session-launch-recovery'
import type { StructuredLaunchSelection } from '../../structured-agent-session-launch-options'
import type {
  StructuredAgentLaunchOptions,
  StructuredLaunchCallerGroup
} from '../../structured-agent-session-launch-callers'
import {
  deleteStructuredAgentLaunchRecord,
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  readStructuredAgentLaunchRecord,
  writeStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'
import type { StructuredAgentLaunchPersistedRecord } from './structured-agent-session-launch-record'
import { structuredAgentLaunchRecordFor } from './structured-agent-session-launch-record'
import {
  removeStructuredLaunchSlot,
  type StructuredLaunchSlotOwner
} from './structured-agent-session-launch-slot'
import {
  markStructuredAgentLaunchCancellation,
  resetStructuredAgentLaunchCancellationForTests,
  retireAbsentStructuredAgentLaunchCancellations,
  retireStructuredAgentLaunchCancellation
} from '../../launch-cancel-tombstones-compat/structured-agent-session-launch-cancellation'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import {
  cancelStructuredAgentLaunchOnLocalHost,
  resetStructuredAgentLocalLaunchCancelsForTests
} from '../../structured-agent-session-local-launch-cancel'

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
  structuredLaunchesBySessionId.clear()
  structuredLaunchListeners.clear()
  resetStructuredAgentLaunchCancellationForTests()
  resetStructuredAgentLocalLaunchCancelsForTests()
}

export function notifyStructuredLaunchListeners(): void {
  for (const state of structuredLaunchesBySessionId.values()) {
    persistStructuredLaunchState(state)
  }
  for (const listener of structuredLaunchListeners) {
    listener()
  }
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

export function deleteStructuredLaunchStateIfCurrent(state: StructuredLaunchState): boolean {
  if (structuredLaunchesBySessionId.get(state.intent.sessionId) !== state) {
    return false
  }
  structuredLaunchesBySessionId.delete(state.intent.sessionId)
  deleteStructuredAgentLaunchRecord(state.intent.sessionId)
  return true
}

function persistStructuredLaunchState(state: StructuredLaunchState): void {
  const lifecycle = launchStateLifecycle(state)
  if (lifecycle === 'published' || lifecycle === 'cancelled') {
    deleteStructuredAgentLaunchRecord(state.intent.sessionId)
    return
  }
  writeStructuredAgentLaunchRecord({
    ...structuredAgentLaunchRecordFor(state.intent, lifecycle),
    ...(lifecycle === 'failed' ? { failedAt: state.callers.failedAt } : {})
  })
}

export function getPersistedStructuredAgentLaunchRecord(
  sessionId: string
): StructuredAgentLaunchPersistedRecord | undefined {
  return readStructuredAgentLaunchRecord(sessionId)
}

export function structuredLaunchStates(): IterableIterator<StructuredLaunchState> {
  return structuredLaunchesBySessionId.values()
}

export function launchStateLifecycle(
  state: StructuredLaunchState
): StructuredAgentSessionLaunchLifecycle {
  if (state.cancelled || state.callers.outcome === 'cancelled') {
    return 'cancelled'
  }
  if (state.callers.outcome === 'published') {
    return 'published'
  }
  if (state.visibilityUnknown || state.callers.outcome === 'unknown') {
    return 'visibility-unknown'
  }
  return state.callers.outcome === 'failed' ? 'failed' : 'pending'
}

function matchesLaunchWorktree(
  state: StructuredLaunchState | undefined,
  worktreeId: string
): boolean {
  return state?.intent.worktreeId === worktreeId
}

export function getStructuredAgentSessionLaunchLifecycle(
  worktreeId: string,
  sessionId: string
): StructuredAgentSessionLaunchLifecycle | null {
  if (hasStructuredAgentSessionLaunchCancellationTombstone(worktreeId, sessionId)) {
    return 'cancelled'
  }
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (state && matchesLaunchWorktree(state, worktreeId)) {
    return launchStateLifecycle(state)
  }
  return getPersistedStructuredAgentLaunchRecord(sessionId)?.lifecycle ?? null
}

/** The host a launch still owed an outcome was sent to, in memory or persisted across a reload. */
export function getStructuredAgentSessionLaunchOwner(
  sessionId: string
): ExecutionHostId | undefined {
  return (
    getStructuredLaunchStateBySessionId(sessionId)?.intent.executionHostId ??
    getPersistedStructuredAgentLaunchRecord(sessionId)?.executionHostId
  )
}

/** The launch adopts an existing conversation, which may keep a model of its own. */
export function getStructuredAgentSessionLaunchResumes(sessionId: string): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const resumeFrom = state
    ? state.intent.params.resumeFrom
    : getPersistedStructuredAgentLaunchRecord(sessionId)?.resumeFrom
  return resumeFrom !== undefined
}

export function getStructuredAgentSessionLaunchFailure(
  worktreeId: string,
  sessionId: string
): StructuredLaunchFailure | null {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  return state &&
    matchesLaunchWorktree(state, worktreeId) &&
    launchStateLifecycle(state) === 'failed'
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

function markStructuredAgentSessionLaunchCancelledInternal(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId,
  owner: StructuredLaunchSlotOwner | undefined
): boolean {
  const alreadyCancelled = hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId)
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const surfaceAddress =
    state?.intent.surfaceAddress ??
    getPersistedStructuredAgentLaunchRecord(sessionId)?.surfaceAddress
  if (matchesLaunchWorktree(state, worktreeId) && state) {
    // The launch's own owner outranks the caller's: it is the host the create was sent to.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && state.intent.executionHostId === LOCAL_EXECUTION_HOST_ID) {
      cancelStructuredAgentLaunchOnLocalHost(worktreeId, sessionId)
    } else {
      markStructuredAgentLaunchCancellation(
        sessionId,
        state.intent.executionHostId,
        alreadyCancelled,
        state.promise
      )
    }
    state.cancelled = true
    state.callers.outcome = 'cancelled'
    // Tombstones remain durable authority; drop in-memory dead promises so bulk closes cannot retain them all session.
    deleteStructuredLaunchStateIfCurrent(state)
  } else if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    !alreadyCancelled &&
    executionHostId === LOCAL_EXECUTION_HOST_ID
  ) {
    cancelStructuredAgentLaunchOnLocalHost(worktreeId, sessionId)
  } else if (!alreadyCancelled) {
    markStructuredAgentLaunchCancellation(sessionId, executionHostId, alreadyCancelled)
  }
  if (owner && surfaceAddress) {
    removeStructuredLaunchSlot(owner, worktreeId, sessionId)
  }
  if (!alreadyCancelled && owner) {
    notifyStructuredLaunchListeners()
  }
  return !alreadyCancelled
}

/** `executionHostId` owns the chat; a launch still in memory names its own. */
export function markStructuredAgentSessionLaunchCancelled(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId,
  owner: StructuredLaunchSlotOwner
): boolean {
  return markStructuredAgentSessionLaunchCancelledInternal(
    worktreeId,
    sessionId,
    executionHostId,
    owner
  )
}

/** Bulk workspace purges run inside a store updater; persist cancellation without notifying React. */
export function markStructuredAgentSessionLaunchCancelledSilently(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId
): boolean {
  return markStructuredAgentSessionLaunchCancelledInternal(
    worktreeId,
    sessionId,
    executionHostId,
    undefined
  )
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
  notifyStructuredLaunchListeners()
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
    notifyStructuredLaunchListeners()
  }
  return changed
}
