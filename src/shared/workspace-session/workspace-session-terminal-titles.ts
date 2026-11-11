import type { WorkspaceSessionState } from './workspace-session-state-types'

export type WorkspaceSessionTitleUpdate = {
  worktreeId: string
  tabId: string
  value: string
}

export type WorkspaceSessionTitlePatch = {
  terminalTitles: WorkspaceSessionTitleUpdate[]
  unifiedLabels: WorkspaceSessionTitleUpdate[]
}

export function applyWorkspaceSessionTerminalTitles(
  session: WorkspaceSessionState,
  updates: WorkspaceSessionTitlePatch
): WorkspaceSessionState {
  let tabsByWorktree = session.tabsByWorktree
  for (const update of updates.terminalTitles) {
    const tabs = tabsByWorktree[update.worktreeId]
    const index = tabs?.findIndex((tab) => tab.id === update.tabId) ?? -1
    const tab = tabs?.[index]
    if (!tab || tab.title === update.value) {
      continue
    }
    const nextTabs = tabs === session.tabsByWorktree[update.worktreeId] ? tabs.slice() : tabs
    nextTabs[index] = { ...tab, title: update.value }
    if (tabsByWorktree === session.tabsByWorktree) {
      tabsByWorktree = { ...tabsByWorktree }
    }
    tabsByWorktree[update.worktreeId] = nextTabs
  }
  let unifiedTabs = session.unifiedTabs
  for (const update of updates.unifiedLabels) {
    if (!unifiedTabs) {
      continue
    }
    const tabs = unifiedTabs[update.worktreeId]
    const index = tabs?.findIndex((tab) => tab.id === update.tabId) ?? -1
    const tab = tabs?.[index]
    if (!tab || tab.contentType !== 'terminal' || tab.label === update.value) {
      continue
    }
    const nextTabs = tabs === session.unifiedTabs?.[update.worktreeId] ? tabs.slice() : tabs
    nextTabs[index] = { ...tab, label: update.value }
    if (unifiedTabs === session.unifiedTabs) {
      unifiedTabs = { ...unifiedTabs }
    }
    unifiedTabs[update.worktreeId] = nextTabs
  }
  return tabsByWorktree === session.tabsByWorktree && unifiedTabs === session.unifiedTabs
    ? session
    : { ...session, tabsByWorktree, unifiedTabs }
}
