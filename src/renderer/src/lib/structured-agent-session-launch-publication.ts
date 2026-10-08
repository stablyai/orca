import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { deleteStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'
import {
  getPersistedStructuredAgentLaunchRecord,
  getStructuredLaunchStateBySessionId,
  hasStructuredAgentSessionLaunchCancellationTombstone,
  notifyStructuredLaunchListeners
} from './structured-agent-session-launch-registry'

/** `executionHostId` published the chat; only the host its launch was sent to settles it. */
export function markStructuredAgentSessionLaunchPublished(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId
): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state) {
    const persisted = getPersistedStructuredAgentLaunchRecord(sessionId)
    if (persisted?.executionHostId !== executionHostId) {
      return false
    }
    deleteStructuredAgentLaunchRecord(sessionId)
    notifyStructuredLaunchListeners()
    return true
  }
  if (
    state.intent.worktreeId !== worktreeId ||
    state.cancelled ||
    state.intent.executionHostId !== executionHostId
  ) {
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

/** Settles every launch a host's publication shows, from whichever mirror carried it. */
export function markStructuredAgentSessionLaunchesPublished(
  executionHostId: ExecutionHostId,
  published: Iterable<{ worktreeId: string; sessionId: string }>
): void {
  for (const { worktreeId, sessionId } of published) {
    if (!hasStructuredAgentSessionLaunchCancellationTombstone(worktreeId, sessionId)) {
      markStructuredAgentSessionLaunchPublished(worktreeId, sessionId, executionHostId)
    }
  }
}

/** The structured chats a host's snapshots show, keyed as launch bookkeeping reads them. */
export function publishedStructuredSessions(
  snapshots: readonly RuntimeMobileSessionTabsResult[]
): { worktreeId: string; sessionId: string }[] {
  return snapshots.flatMap((snapshot) =>
    snapshot.tabs.flatMap((tab) =>
      tab.type === 'agent-session'
        ? [{ worktreeId: snapshot.worktree, sessionId: tab.sessionId }]
        : []
    )
  )
}
