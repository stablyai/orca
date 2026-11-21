import { keyedListsMatch } from '@/store/record-transitions/keyed-list-match'
import { isAgentTaskCompleteTrackingEnabledFromState as isAgentHookCompletionTrackingEnabled } from '@/components/terminal-pane/notifications/agent-task-complete-policy'

type CompletionNotificationSettings = {
  readonly enabled?: boolean
  readonly agentTaskComplete?: boolean
}

type CompletionStoreSettings = {
  readonly notifications?: CompletionNotificationSettings
  readonly experimentalTerminalAttention?: boolean
}

type CompletionTerminalTab = {
  readonly id: string
  readonly ptyId?: string | null
  readonly title?: string
}

export type AgentHookCompletionStoreSnapshot = {
  readonly settings: CompletionStoreSettings | null
  readonly tabsByWorktree: Readonly<Record<string, readonly CompletionTerminalTab[]>>
  readonly ptyIdsByTabId: Readonly<Record<string, readonly string[]>>
  readonly terminalLayoutsByTabId: Readonly<Record<string, unknown>>
  readonly suppressedPtyExitIds: Readonly<Record<string, boolean>>
}

type TabVisit = () => void

function terminalTabLivenessMatches(
  current: AgentHookCompletionStoreSnapshot['tabsByWorktree'],
  previous: AgentHookCompletionStoreSnapshot['tabsByWorktree'],
  visitTab?: TabVisit
): boolean {
  // Key order counts: first-worktree-wins IDs make a reorder a liveness change even with reused arrays.
  return keyedListsMatch(current, previous, (currentTab, previousTab) => {
    visitTab?.()
    return currentTab.id === previousTab.id && currentTab.ptyId === previousTab.ptyId
  })
}

function shouldSync(
  current: AgentHookCompletionStoreSnapshot,
  previous: AgentHookCompletionStoreSnapshot,
  visitTab?: TabVisit
): boolean {
  if (
    isAgentHookCompletionTrackingEnabled(current) !== isAgentHookCompletionTrackingEnabled(previous)
  ) {
    return true
  }
  if (
    current.ptyIdsByTabId !== previous.ptyIdsByTabId ||
    current.terminalLayoutsByTabId !== previous.terminalLayoutsByTabId ||
    current.suppressedPtyExitIds !== previous.suppressedPtyExitIds
  ) {
    return true
  }
  return !terminalTabLivenessMatches(current.tabsByWorktree, previous.tabsByWorktree, visitTab)
}

export function shouldSyncAgentHookCompletionForStoreUpdate(
  current: AgentHookCompletionStoreSnapshot,
  previous: AgentHookCompletionStoreSnapshot
): boolean {
  return shouldSync(current, previous)
}

export function _measureAgentHookCompletionStoreSyncForTest(
  current: AgentHookCompletionStoreSnapshot,
  previous: AgentHookCompletionStoreSnapshot
): { shouldSync: boolean; tabVisits: number } {
  let tabVisits = 0
  const requiresSync = shouldSync(current, previous, () => {
    tabVisits += 1
  })
  return { shouldSync: requiresSync, tabVisits }
}
