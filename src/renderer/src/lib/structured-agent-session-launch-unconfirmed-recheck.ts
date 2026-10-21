import type { ExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '@/store'
import { retryStructuredAgentSessionLaunch } from './structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredAgentSessionLaunchOwner,
  structuredLaunchStates
} from './structured-agent-session-launch-registry'

/**
 * `executionHostId` is reachable again: its full inventory just arrived on a new subscription.
 * Re-checks each launch it owns whose create was never confirmed, as Retry would, so it settles to
 * published or failed without the user. One still unconfirmed waits for the host's next return;
 * a cancelled launch reads as cancelled and is skipped.
 */
export function recheckUnconfirmedStructuredAgentLaunches(executionHostId: ExecutionHostId): void {
  const launches = [...structuredLaunchStates()].map(({ intent }) => ({
    worktreeId: intent.worktreeId,
    sessionId: intent.sessionId
  }))
  // A launch from before a reload is known only by its saved record and the tab still showing it.
  for (const [worktreeId, tabs] of Object.entries(useAppStore.getState().unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.contentType === 'agent-session') {
        launches.push({ worktreeId, sessionId: tab.entityId })
      }
    }
  }
  for (const { worktreeId, sessionId } of launches) {
    if (
      getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId) !== 'visibility-unknown' ||
      getStructuredAgentSessionLaunchOwner(sessionId) !== executionHostId
    ) {
      continue
    }
    try {
      retryStructuredAgentSessionLaunch(worktreeId, sessionId)
    } catch (error) {
      // Why: recovery bookkeeping must not break the inventory that reported the host back.
      console.warn('[structured-agent-launch] unconfirmed launch re-check failed', error)
    }
  }
}
