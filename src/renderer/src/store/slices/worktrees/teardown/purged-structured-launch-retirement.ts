import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { TerminalTab } from '../../../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../../../shared/tab-types'
import type { AppState } from '../../../types'
import type { WorktreePurgeTarget } from '../../worktree-helpers'
import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'
import { settleAgentLaunchPaneStart } from '@/lib/agent-launch-pane-start'
import {
  getStructuredAgentSessionLaunchOwner,
  markStructuredAgentSessionLaunchCancelledSilently,
  shouldRetainStructuredAgentSessionLaunchTab,
  structuredLaunchStates
} from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { discardStructuredAgentSessionChatSends } from '@/lib/agent-session/launch/structured-agent-session-launch-prompt'
import { forgetUnlistedCreatedChat } from '@/lib/structured-agent-session-unlisted-created-chats'
import { readStructuredAgentLaunchRecords } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { retireStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner-registry'
import { clearWebSessionFocusIntentIfMatches } from '@/runtime/web-session-focus-intent'
import {
  structuredAgentSessionFocusOwner,
  structuredAgentSessionTargetForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'

import { flushRetiredHostEdits } from './removed-workspace-unsaved-files'
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
      forgetUnlistedCreatedChat(worktreeId, tab.entityId)
      retireStructuredAgentSessionReadOwner(
        tab.entityId,
        structuredAgentSessionTargetForHost(tab.executionHostId),
        tab.executionHostId ?? ''
      )
      const target = structuredAgentSessionTargetForTab(s, tab)
      if (target) {
        forgetStructuredSessionSelection(tab.entityId, target)
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

/** A host launch waits on its own host: another host dropping the same workspace id ends nothing. */
function hostLaunchDropped(
  droppedBy: readonly WorktreePurgeTarget[] | undefined,
  worktreeId: string,
  executionHostId: ExecutionHostId
): boolean {
  return (
    !droppedBy ||
    droppedBy.some(
      (target) => target.id === worktreeId && (!target.hostId || target.hostId === executionHostId)
    )
  )
}

/** Cancels provisional structured-chat launches in these worktrees, on the given host only.
 *  `droppedBy` names the host each id was dropped by, when the purge knows it. */
export function cancelStructuredLaunchesForWorktrees(
  worktreeIdSet: ReadonlySet<string>,
  ownedByHost?: (worktreeId: string, executionHostId: ExecutionHostId) => boolean,
  droppedBy?: readonly WorktreePurgeTarget[]
): Set<string> {
  const cancelledSessionIds = new Set<string>()
  for (const launch of structuredLaunchStates()) {
    const worktreeId = launch.intent.worktreeId
    if (
      worktreeIdSet.has(worktreeId) &&
      (!ownedByHost || ownedByHost(worktreeId, launch.intent.executionHostId)) &&
      (!launch.intent.hostLaunch ||
        hostLaunchDropped(droppedBy, worktreeId, launch.intent.executionHostId)) &&
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
  // the workspace it will open in. So does a host launch whose chat never showed, on any host:
  // its own host's listing dropping the workspace is the only thing that ends it short of a Dismiss.
  for (const record of readStructuredAgentLaunchRecords()) {
    const worktreeId = record.surfaceAddress?.worktreeId
    const hostLaunch = record.hostLaunchOperationId !== undefined
    if (
      (record.executionHostId === 'local' || hostLaunch) &&
      worktreeId &&
      (!hostLaunch || hostLaunchDropped(droppedBy, worktreeId, record.executionHostId)) &&
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

/** Before a removed paired host's purge: delayed views commit text it may offer back, and its
 *  saved chat launches end with it, including those whose workspace this window never loaded, so
 *  no row outlives the host it waits on. */
export function settleRetiredHostInput(state: AppState, removed: ReadonlySet<string>): void {
  flushRetiredHostEdits(state, removed)
  const hostIds = new Set<ExecutionHostId>([...removed].map(toRuntimeExecutionHostId))
  for (const record of readStructuredAgentLaunchRecords()) {
    const worktreeId = record.surfaceAddress?.worktreeId
    if (worktreeId && hostIds.has(record.executionHostId)) {
      markStructuredAgentSessionLaunchCancelledSilently(
        worktreeId,
        record.sessionId,
        record.executionHostId
      )
      discardStructuredAgentSessionChatSends(record.sessionId)
    }
  }
}
