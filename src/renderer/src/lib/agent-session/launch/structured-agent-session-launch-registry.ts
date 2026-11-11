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
import { hasStructuredAgentLaunchCancellationTombstonePersisted } from './structured-agent-session-launch-persistence'
import {
  resetStructuredAgentLaunchCancellationForTests,
  retireAbsentStructuredAgentLaunchCancellations,
  retireStructuredAgentLaunchCancellation
} from './structured-agent-session-launch-cancellation'
import { resetStructuredAgentLocalLaunchCancelsForTests } from './structured-agent-session-local-launch-cancel'
import {
  clearStructuredLaunchStateStoreForTests,
  getPersistedStructuredAgentLaunchRecord,
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners,
  structuredLaunchSessionIds,
  subscribeStructuredAgentLaunchStatus
} from './structured-agent-session-launch-state-store'

export {
  deleteStructuredLaunchStateIfCurrent,
  getPersistedStructuredAgentLaunchRecord,
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners,
  publishStructuredLaunchChange,
  setStructuredLaunchState,
  structuredLaunchStates,
  subscribeStructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './structured-agent-session-launch-state-store'

export type StructuredAgentLaunchStatus = 'idle' | 'pending' | 'unknown'
export type StructuredAgentSessionLaunchLifecycle =
  | 'pending'
  | 'visibility-unknown'
  | 'failed'
  | 'published'
  | 'cancelled'

export function resetStructuredAgentLaunchRegistryForTests(): void {
  for (const sessionId of structuredLaunchSessionIds()) {
    forgetStructuredSessionSelection(sessionId)
  }
  clearStructuredLaunchStateStoreForTests()
  resetStructuredAgentLaunchCancellationForTests()
  resetStructuredAgentLocalLaunchCancelsForTests()
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
