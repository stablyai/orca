import { findAgentStatusOwner } from '../../../agent-status-commit'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { TerminalTab } from '../../../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../../../shared/tab-types'
import type { AppState } from '../../../types'
import { prepareAgentLaunchPaneSettlement } from '@/lib/agent-launch-pane-start'
import {
  getStructuredAgentSessionLaunchOwner,
  prepareStructuredAgentSessionLaunchCancellation,
  shouldRetainStructuredAgentSessionLaunchTab,
  structuredLaunchStates
} from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { prepareStructuredAgentSessionChatSendRemoval } from '@/lib/structured-agent-session-launch-prompt'
import { prepareUnlistedCreatedChatRemoval } from '@/lib/structured-agent-session-unlisted-created-chats'
import { readStructuredAgentLaunchRecords } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import {
  prepareStructuredReadRetirement,
  installStructuredReadRetirement
} from '@/components/native-chat/structured-agent-session-read-owner-registry'
import { preparePurgeOwnership } from './worktree-purge-preparation'
import { prepareWebSessionFocusIntentRemoval } from '@/runtime/web-session-focus-intent'
import {
  structuredAgentSessionFocusOwner,
  structuredAgentSessionTargetForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'

function prepareReaderRetirement(
  s: AppState,
  sessionId: string,
  target: Parameters<typeof prepareStructuredReadRetirement>[2]
): void {
  const owner = findAgentStatusOwner(s)
  if (owner) {
    owner.transact((transaction) => transaction.retireReadOwner(sessionId, target))
  } else {
    const reader = prepareStructuredReadRetirement(null, sessionId, target)
    installStructuredReadRetirement(reader)
    for (const effect of reader.effects) {
      effect()
    }
  }
}
function prepareLaunchCancellation(
  s: AppState,
  worktreeId: string,
  sessionId: string,
  host: ExecutionHostId
): boolean {
  const cancelled = findAgentStatusOwner(s)?.purgedLaunches()
  const key = `${host}:${sessionId}`
  if (cancelled?.has(key)) {
    return false
  }
  const prepared = prepareStructuredAgentSessionLaunchCancellation(worktreeId, sessionId, host)
  cancelled?.add(key)
  preparePurgeOwnership(s, prepared)
  return true
}

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
      preparePurgeOwnership(s, prepareAgentLaunchPaneSettlement(tab.id, tab.agentLaunchPane.leafId))
    }
  }
  for (const tab of unifiedTabs) {
    if (tab.contentType === 'agent-session') {
      preparePurgeOwnership(s, prepareUnlistedCreatedChatRemoval(worktreeId, tab.entityId))
      const target = structuredAgentSessionTargetForTab(s, tab)
      if (target) {
        prepareReaderRetirement(s, tab.entityId, target)
      }
    }
    // A retained launch here survived a reload, so its persisted record names its host.
    const owner =
      tab.contentType === 'agent-session' && !cancelledSessionIds.has(tab.entityId)
        ? getStructuredAgentSessionLaunchOwner(tab.entityId)
        : undefined
    const target = structuredAgentSessionTargetForHost(owner)
    if (
      owner &&
      target &&
      shouldRetainStructuredAgentSessionLaunchTab(worktreeId, tab.entityId) &&
      prepareLaunchCancellation(s, worktreeId, tab.entityId, owner)
    ) {
      preparePurgeOwnership(s, prepareStructuredAgentSessionChatSendRemoval(tab.entityId))
      preparePurgeOwnership(
        s,
        prepareWebSessionFocusIntentRemoval(
          structuredAgentSessionFocusOwner(target),
          worktreeId,
          `agent-session:${tab.entityId}`
        )
      )
    }
  }
}

/** Cancels provisional structured-chat launches in these worktrees, on the given host only. */
export function cancelStructuredLaunchesForWorktrees(
  s: AppState,
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
      if (
        !prepareLaunchCancellation(
          s,
          worktreeId,
          launch.intent.sessionId,
          launch.intent.executionHostId
        )
      ) {
        cancelledSessionIds.add(launch.intent.sessionId)
        continue
      }
      preparePurgeOwnership(
        s,
        prepareStructuredAgentSessionChatSendRemoval(launch.intent.sessionId)
      )
      prepareReaderRetirement(s, launch.intent.sessionId, launch.intent.target)
      preparePurgeOwnership(
        s,
        prepareWebSessionFocusIntentRemoval(
          structuredAgentSessionFocusOwner(launch.intent.target),
          worktreeId,
          `agent-session:${launch.intent.sessionId}`
        )
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
      if (!prepareLaunchCancellation(s, worktreeId, record.sessionId, record.executionHostId)) {
        continue
      }
      preparePurgeOwnership(s, prepareStructuredAgentSessionChatSendRemoval(record.sessionId))
      cancelledSessionIds.add(record.sessionId)
    }
  }
  return cancelledSessionIds
}
