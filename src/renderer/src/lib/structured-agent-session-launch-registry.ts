import { useSyncExternalStore } from 'react'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionWriteRefusal } from '../../../shared/agent-session-write-failure'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type { ExecutionHostId } from '../../../shared/execution-host'
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
  structuredAgentLaunchRecordFor,
  writeStructuredAgentLaunchRecord,
  type StructuredAgentLaunchPersistedRecord
} from './structured-agent-session-launch-persistence'
import {
  markStructuredAgentLaunchCancellation,
  resetStructuredAgentLaunchCancellationForTests,
  retireAbsentStructuredAgentLaunchCancellations,
  retireStructuredAgentLaunchCancellation
} from './structured-agent-session-launch-cancellation'

export type StructuredLaunchState = StructuredLaunchRecoveryState & {
  identity: string
  /** Fixed by the caller that opened this launch so coalesced prompts use one delivery mode. */
  promptDelivery: StructuredAgentLaunchOptions['promptDelivery']
  callers: StructuredLaunchCallerGroup
  /** The host's refusal behind the last failed attempt, worded beside Retry. Absent when the
   *  failure named none. */
  failure?: AgentSessionWriteRefusal
  selection: StructuredLaunchSelection
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

// Why keyed by agent: one worktree can hold a Claude and a Codex launch at once.
// Why keyed by conversation: a resume must not coalesce onto an unrelated blank launch.
export function structuredLaunchIdentity(
  worktreeId: string,
  agent: AgentSessionHandleProvider,
  resumeFrom?: StructuredAgentSessionResumeSource
): string {
  return resumeFrom
    ? `${agent}:${worktreeId}:resume:${resumeFrom.providerSessionId}`
    : `${agent}:${worktreeId}`
}

// Why: coalescing stops two creates racing for one chat. A failed launch is not racing; it gives up
// its identity, so a new start makes a new chat while the failed one keeps its own Retry.
function holdsLaunchIdentity(state: StructuredLaunchState): boolean {
  const lifecycle = launchStateLifecycle(state)
  return lifecycle !== 'failed' && lifecycle !== 'cancelled'
}

export function structuredLaunchesHoldingIdentity(
  matches: (identity: string) => boolean
): StructuredLaunchState[] {
  return [...structuredLaunchesBySessionId.values()].filter(
    (state) => matches(state.identity) && holdsLaunchIdentity(state)
  )
}

/** The launch a new start for `identity` joins; the newest wins if a retried chat holds it too. */
export function getJoinableStructuredLaunchState(
  identity: string
): StructuredLaunchState | undefined {
  return structuredLaunchesHoldingIdentity((candidate) => candidate === identity).at(-1)
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
  writeStructuredAgentLaunchRecord(structuredAgentLaunchRecordFor(state.intent, lifecycle))
}

export function getPersistedStructuredAgentLaunchRecord(
  sessionId: string
): StructuredAgentLaunchPersistedRecord | undefined {
  return readStructuredAgentLaunchRecord(sessionId)
}

export function structuredLaunchStates(): IterableIterator<StructuredLaunchState> {
  return structuredLaunchesBySessionId.values()
}

function launchStateLifecycle(state: StructuredLaunchState): StructuredAgentSessionLaunchLifecycle {
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
): AgentSessionWriteRefusal | null {
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
): AgentSessionWriteRefusal | null {
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
  notify: boolean
): boolean {
  const alreadyCancelled = hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId)
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (matchesLaunchWorktree(state, worktreeId) && state) {
    // The launch's own owner outranks the caller's: it is the host the create was sent to.
    markStructuredAgentLaunchCancellation(
      sessionId,
      state.intent.executionHostId,
      alreadyCancelled,
      state.promise
    )
    state.cancelled = true
    state.callers.outcome = 'cancelled'
    // The tombstone is the durable authority; drop the in-memory launch so bulk closes cannot
    // retain a dead promise for the lifetime of the renderer.
    deleteStructuredLaunchStateIfCurrent(state)
  } else if (!alreadyCancelled) {
    markStructuredAgentLaunchCancellation(sessionId, executionHostId, alreadyCancelled)
  }
  if (!alreadyCancelled && notify) {
    notifyStructuredLaunchListeners()
  }
  return !alreadyCancelled
}

/** `executionHostId` owns the chat; a launch still in memory names its own. */
export function markStructuredAgentSessionLaunchCancelled(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId
): boolean {
  return markStructuredAgentSessionLaunchCancelledInternal(
    worktreeId,
    sessionId,
    executionHostId,
    true
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
    false
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
