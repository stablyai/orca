import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { TerminalTab } from '../../../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../../../shared/tab-types'
import type { AppState } from '../../../types'
import { settleAgentLaunchPaneStart } from '@/lib/agent-launch-pane-start'
import {
  getStructuredAgentSessionLaunchOwner,
  markStructuredAgentSessionLaunchCancelledSilently,
  shouldRetainStructuredAgentSessionLaunchTab,
  structuredLaunchStates
} from '@/lib/structured-agent-session-launch-registry'
import { discardStructuredAgentSessionChatSends } from '@/lib/structured-agent-session-launch-prompt'
import { readStructuredAgentLaunchRecords } from '@/lib/structured-agent-session-launch-persistence'
import { retireStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner-registry'
import { clearWebSessionFocusIntentIfMatches } from '@/runtime/web-session-focus-intent'
import {
  structuredAgentSessionFocusOwner,
  structuredAgentSessionTargetForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'

/** Settles launch waits and retires chat ownership for purged tabs of one workspace. */
export function retirePurgedTabLaunches(
  s: AppState,
  worktreeId: string,
  terminalTabs: readonly TerminalTab[],
  unifiedTabs: readonly Tab[],
  cancelledSessionIds: ReadonlySet<string>
): void {
  // A launch tab that never spawned has no spawn left to answer its prompt's wait.
  for (const tab of terminalTabs) {
    if (tab.agentLaunchPane) {
      settleAgentLaunchPaneStart(tab.id, tab.agentLaunchPane.leafId, null)
    }
  }
  for (const tab of unifiedTabs) {
    if (tab.contentType === 'agent-session') {
      const target = structuredAgentSessionTargetForTab(s, tab)
      if (target) {
        retireStructuredAgentSessionReadOwner(tab.entityId, target)
      }
    }
    // A retained launch here survived a reload, so its persisted record names its host.
    const owner =
      tab.contentType === 'agent-session' && !cancelledSessionIds.has(tab.entityId)
        ? getStructuredAgentSessionLaunchOwner(tab.entityId)
        : undefined
    const target = structuredAgentSessionTargetForHost(owner)
    if (owner && target && shouldRetainStructuredAgentSessionLaunchTab(worktreeId, tab.entityId)) {
      markStructuredAgentSessionLaunchCancelledSilently(worktreeId, tab.entityId, owner)
      discardStructuredAgentSessionChatSends(tab.entityId)
      clearWebSessionFocusIntentIfMatches(
        structuredAgentSessionFocusOwner(target),
        worktreeId,
        `agent-session:${tab.entityId}`
      )
    }
  }
}

/** Cancels provisional structured-chat launches in these worktrees, on the given host only. */
export function cancelStructuredLaunchesForWorktrees(
  worktreeIdSet: ReadonlySet<string>,
  ownedByHost?: (worktreeId: string, executionHostId: ExecutionHostId) => boolean
): Set<string> {
  const cancelledSessionIds = new Set<string>()
  for (const launch of structuredLaunchStates()) {
    const worktreeId = launch.intent.worktreeId
    if (
      worktreeIdSet.has(worktreeId) &&
      (!ownedByHost || ownedByHost(worktreeId, launch.intent.executionHostId)) &&
      shouldRetainStructuredAgentSessionLaunchTab(worktreeId, launch.intent.sessionId)
    ) {
      markStructuredAgentSessionLaunchCancelledSilently(
        worktreeId,
        launch.intent.sessionId,
        launch.intent.executionHostId
      )
      discardStructuredAgentSessionChatSends(launch.intent.sessionId)
      retireStructuredAgentSessionReadOwner(launch.intent.sessionId, launch.intent.target)
      clearWebSessionFocusIntentIfMatches(
        structuredAgentSessionFocusOwner(launch.intent.target),
        worktreeId,
        `agent-session:${launch.intent.sessionId}`
      )
      cancelledSessionIds.add(launch.intent.sessionId)
    }
  }
  // A resume that publishes on commit has no tab or in-memory launch yet; its saved record names
  // the workspace it will open in.
  for (const record of readStructuredAgentLaunchRecords()) {
    const worktreeId = record.surfaceAddress?.worktreeId
    if (
      record.executionHostId === 'local' &&
      worktreeId &&
      worktreeIdSet.has(worktreeId) &&
      (!ownedByHost || ownedByHost(worktreeId, record.executionHostId)) &&
      !cancelledSessionIds.has(record.sessionId)
    ) {
      markStructuredAgentSessionLaunchCancelledSilently(
        worktreeId,
        record.sessionId,
        record.executionHostId
      )
      discardStructuredAgentSessionChatSends(record.sessionId)
      cancelledSessionIds.add(record.sessionId)
    }
  }
  return cancelledSessionIds
}
