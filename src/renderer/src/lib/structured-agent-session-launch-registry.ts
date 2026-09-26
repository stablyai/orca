import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
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
  /** Why the last attempt failed, shown beside Retry; the toast stays generic. */
  failureReason?: string
  selection: StructuredLaunchSelection
}

export type StructuredAgentLaunchStatus = 'idle' | 'pending' | 'unknown'
export type StructuredAgentSessionLaunchLifecycle =
  | 'pending'
  | 'visibility-unknown'
  | 'failed'
  | 'published'
  | 'cancelled'

const pendingStructuredLaunchesByIdentity = new Map<string, StructuredLaunchState>()
const structuredLaunchesBySessionId = new Map<string, StructuredLaunchState>()
const structuredLaunchListeners = new Set<() => void>()

export function resetStructuredAgentLaunchRegistryForTests(): void {
  pendingStructuredLaunchesByIdentity.clear()
  structuredLaunchesBySessionId.clear()
  structuredLaunchListeners.clear()
  resetStructuredAgentLaunchCancellationForTests()
}

export function notifyStructuredLaunchListeners(): void {
  for (const state of pendingStructuredLaunchesByIdentity.values()) {
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

export function getStructuredLaunchState(identity: string): StructuredLaunchState | undefined {
  return pendingStructuredLaunchesByIdentity.get(identity)
}

export function getStructuredLaunchStateBySessionId(
  sessionId: string
): StructuredLaunchState | undefined {
  return structuredLaunchesBySessionId.get(sessionId)
}

export function setStructuredLaunchState(state: StructuredLaunchState): void {
  pendingStructuredLaunchesByIdentity.set(state.identity, state)
  structuredLaunchesBySessionId.set(state.intent.sessionId, state)
  persistStructuredLaunchState(state)
}

export function deleteStructuredLaunchStateIfCurrent(state: StructuredLaunchState): boolean {
  if (pendingStructuredLaunchesByIdentity.get(state.identity) !== state) {
    return false
  }
  pendingStructuredLaunchesByIdentity.delete(state.identity)
  if (structuredLaunchesBySessionId.get(state.intent.sessionId) === state) {
    structuredLaunchesBySessionId.delete(state.intent.sessionId)
  }
  deleteStructuredAgentLaunchRecord(state.intent.sessionId)
  return true
}

function persistStructuredLaunchState(state: StructuredLaunchState): void {
  const lifecycle = launchStateLifecycle(state)
  if (lifecycle === 'published' || lifecycle === 'cancelled') {
    deleteStructuredAgentLaunchRecord(state.intent.sessionId)
    return
  }
  const { envelope, resumeFrom } = state.intent.params
  const record: StructuredAgentLaunchPersistedRecord = {
    sessionId: state.intent.sessionId,
    agent: state.intent.agent,
    lifecycle,
    clientOperationId: envelope.clientOperationId,
    payloadFingerprint: envelope.payloadFingerprint,
    expectedRuntimeFence: envelope.expectedRuntimeFence,
    target: state.intent.target,
    ...(resumeFrom ? { resumeFrom } : {})
  }
  writeStructuredAgentLaunchRecord(record)
}

export function getPersistedStructuredAgentLaunchRecord(
  sessionId: string
): StructuredAgentLaunchPersistedRecord | undefined {
  return readStructuredAgentLaunchRecord(sessionId)
}

export function structuredLaunchStates(): IterableIterator<StructuredLaunchState> {
  return pendingStructuredLaunchesByIdentity.values()
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

/** The launch adopts an existing conversation, which may keep a model of its own. */
export function getStructuredAgentSessionLaunchResumes(sessionId: string): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const resumeFrom = state
    ? state.intent.params.resumeFrom
    : getPersistedStructuredAgentLaunchRecord(sessionId)?.resumeFrom
  return resumeFrom !== undefined
}

export function getStructuredAgentSessionLaunchFailureReason(
  worktreeId: string,
  sessionId: string
): string | null {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  return state &&
    matchesLaunchWorktree(state, worktreeId) &&
    launchStateLifecycle(state) === 'failed'
    ? (state.failureReason ?? null)
    : null
}

export function shouldRetainStructuredAgentSessionLaunchTab(
  worktreeId: string,
  sessionId: string
): boolean {
  const lifecycle = getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId)
  return lifecycle === 'pending' || lifecycle === 'visibility-unknown' || lifecycle === 'failed'
}

export function markStructuredAgentSessionLaunchPublished(
  worktreeId: string,
  sessionId: string
): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state) {
    const persisted = getPersistedStructuredAgentLaunchRecord(sessionId)
    if (!persisted) {
      return false
    }
    deleteStructuredAgentLaunchRecord(sessionId)
    notifyStructuredLaunchListeners()
    return true
  }
  if (!matchesLaunchWorktree(state, worktreeId) || state.cancelled) {
    return false
  }
  if (state.callers.outcome === 'published') {
    return true
  }
  // Still in flight: its own settlement publishes once the picks held during launch land.
  if (state.callers.outcome === 'pending') {
    return true
  }
  state.callers.outcome = 'published'
  deleteStructuredAgentLaunchRecord(sessionId)
  state.callers.onSettled()
  notifyStructuredLaunchListeners()
  return true
}

function markStructuredAgentSessionLaunchCancelledInternal(
  worktreeId: string,
  sessionId: string,
  notify: boolean,
  ownerTarget?: RuntimeClientTarget
): boolean {
  const alreadyCancelled = hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId)
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (matchesLaunchWorktree(state, worktreeId) && state) {
    markStructuredAgentLaunchCancellation(
      sessionId,
      alreadyCancelled,
      state.promise,
      state.intent.target
    )
    state.cancelled = true
    state.callers.outcome = 'cancelled'
    // The tombstone is the durable authority; drop the in-memory launch so bulk closes cannot
    // retain a dead promise for the lifetime of the renderer.
    deleteStructuredLaunchStateIfCurrent(state)
  } else if (!alreadyCancelled) {
    markStructuredAgentLaunchCancellation(sessionId, alreadyCancelled, undefined, ownerTarget)
  }
  if (!alreadyCancelled && notify) {
    notifyStructuredLaunchListeners()
  }
  return !alreadyCancelled
}

export function markStructuredAgentSessionLaunchCancelled(
  worktreeId: string,
  sessionId: string,
  ownerTarget?: RuntimeClientTarget
): boolean {
  return markStructuredAgentSessionLaunchCancelledInternal(worktreeId, sessionId, true, ownerTarget)
}

/** Bulk workspace purges run inside a store updater; persist cancellation without notifying React. */
export function markStructuredAgentSessionLaunchCancelledSilently(
  worktreeId: string,
  sessionId: string,
  ownerTarget?: RuntimeClientTarget
): boolean {
  return markStructuredAgentSessionLaunchCancelledInternal(
    worktreeId,
    sessionId,
    false,
    ownerTarget
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
  target: RuntimeClientTarget = { kind: 'local' }
): boolean {
  const changed = retireAbsentStructuredAgentLaunchCancellations(
    publishedSessionIds,
    authoritativeInventory,
    target
  )
  if (changed) {
    notifyStructuredLaunchListeners()
  }
  return changed
}

export function getStructuredAgentLaunchStatus(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): StructuredAgentLaunchStatus {
  // Any launch for this pair, including adopted conversations, means a chat is starting here.
  const states = [
    getStructuredLaunchState(structuredLaunchIdentity(worktreeId, agent)),
    ...[...pendingStructuredLaunchesByIdentity.entries()]
      .filter(([identity]) => identity.startsWith(`${agent}:${worktreeId}:resume:`))
      .map(([, state]) => state)
  ].filter((state): state is StructuredLaunchState => Boolean(state))
  if (states.length === 0) {
    return 'idle'
  }
  return states.some((state) => state.visibilityUnknown) ? 'unknown' : 'pending'
}
