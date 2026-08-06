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

function isTrackingEnabled(state: AgentHookCompletionStoreSnapshot): boolean {
  const notifications = state.settings?.notifications
  const notificationEnabled =
    notifications?.enabled !== false && notifications?.agentTaskComplete !== false
  return notificationEnabled || state.settings?.experimentalTerminalAttention === true
}

function terminalTabLivenessMatches(
  current: AgentHookCompletionStoreSnapshot['tabsByWorktree'],
  previous: AgentHookCompletionStoreSnapshot['tabsByWorktree'],
  visitTab?: TabVisit
): boolean {
  if (current === previous) {
    return true
  }

  const currentWorktreeIds = Object.keys(current)
  const previousWorktreeIds = Object.keys(previous)
  if (currentWorktreeIds.length !== previousWorktreeIds.length) {
    return false
  }

  for (const [worktreeIndex, worktreeId] of currentWorktreeIds.entries()) {
    // Why: duplicate tab ids use first-worktree-wins lookup semantics, so a
    // worktree-key reorder is a liveness change even when every array is reused.
    if (previousWorktreeIds[worktreeIndex] !== worktreeId) {
      return false
    }
    const currentTabs = current[worktreeId]
    const previousTabs = previous[worktreeId]
    if (currentTabs === previousTabs) {
      continue
    }
    if (!currentTabs || !previousTabs || currentTabs.length !== previousTabs.length) {
      return false
    }
    for (const [tabIndex, currentTab] of currentTabs.entries()) {
      visitTab?.()
      const previousTab = previousTabs[tabIndex]
      if (
        !previousTab ||
        currentTab.id !== previousTab.id ||
        currentTab.ptyId !== previousTab.ptyId
      ) {
        return false
      }
    }
  }
  return true
}

function shouldSync(
  current: AgentHookCompletionStoreSnapshot,
  previous: AgentHookCompletionStoreSnapshot,
  visitTab?: TabVisit
): boolean {
  if (isTrackingEnabled(current) !== isTrackingEnabled(previous)) {
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
