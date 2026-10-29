import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { useAppStore } from '@/store/index'
import { retryStructuredAgentSessionLaunch } from '../../structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredAgentSessionLaunchOwner,
  structuredLaunchStates
} from './structured-agent-session-launch-registry'

/** On host inventory reconnect, recheck its unconfirmed launches as Retry does. Settle published/failed; still-unknown waits for the next return, and cancellation skips. */
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
      // Recovery bookkeeping must not break the inventory that announced reconnection.
      console.warn('[structured-agent-launch] unconfirmed launch re-check failed', error)
    }
  }
}
