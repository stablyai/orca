import type { OpenTabSearchEntries, OpenTabSearchEntryState } from './open-tab-search-entries'

type ExcludedStripTab =
  | { kind: 'tab'; tabId: string }
  | { kind: 'browser-page'; workspaceId: string }
  | { kind: 'ungrouped' }

// Omit the tab already showing in this strip; active tabs in sibling splits stay reachable.
function resolveExcludedStripTab(
  state: OpenTabSearchEntryState,
  groupId: string | null | undefined,
  clientHostedRowActive: boolean
): ExcludedStripTab | null {
  if (clientHostedRowActive) {
    return null
  }
  const worktreeId = state.worktree.id
  const groups = state.groupsByWorktree[worktreeId] ?? []
  if (groups.length === 0) {
    return { kind: 'ungrouped' }
  }
  const resolvedGroupId = groupId ?? state.activeGroupIdByWorktree[worktreeId]
  const group = resolvedGroupId
    ? groups.find((candidate) => candidate.id === resolvedGroupId)
    : undefined
  if (!group?.activeTabId) {
    return null
  }
  const activeTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.id === group.activeTabId && tab.groupId === group.id
  )
  if (!activeTab) {
    return null
  }
  return activeTab.contentType === 'browser'
    ? { kind: 'browser-page', workspaceId: activeTab.entityId }
    : { kind: 'tab', tabId: activeTab.id }
}

export function excludeActiveStripOpenTabEntries(
  entries: OpenTabSearchEntries,
  state: OpenTabSearchEntryState,
  options: { clientHostedRowActive?: boolean; groupId?: string | null }
): OpenTabSearchEntries {
  const excluded = resolveExcludedStripTab(
    state,
    options.groupId,
    options.clientHostedRowActive === true
  )
  if (!excluded) {
    return entries
  }
  if (excluded.kind === 'ungrouped') {
    return {
      workspaceTabs: entries.workspaceTabs.filter((entry) => !entry.isCurrentTab),
      browserPages: entries.browserPages.filter((entry) => !entry.isCurrentPage),
      simulatorTabs: entries.simulatorTabs.filter((entry) => !entry.isCurrentTab)
    }
  }
  if (excluded.kind === 'browser-page') {
    return {
      workspaceTabs: entries.workspaceTabs,
      browserPages: entries.browserPages.filter(
        (entry) =>
          !(
            entry.workspace.id === excluded.workspaceId &&
            entry.workspace.activePageId === entry.page.id
          )
      ),
      simulatorTabs: entries.simulatorTabs
    }
  }
  return {
    workspaceTabs: entries.workspaceTabs.filter((entry) => entry.tab.id !== excluded.tabId),
    browserPages: entries.browserPages,
    simulatorTabs: entries.simulatorTabs.filter((entry) => entry.tab.id !== excluded.tabId)
  }
}
