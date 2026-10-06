import { useAppStore } from '../../store'
import { resolveBrowserSessionTabTarget } from './browser-session-tab-target'
import { resolveWindowTabIdForHostTab } from './host-session-tab-target'

export function focusExistingWorkspaceTab({
  tabId,
  worktreeId,
  userInitiated
}: {
  tabId: string
  worktreeId: string
  userInitiated?: boolean
}): boolean {
  const localTabId = resolveWindowTabIdForHostTab(worktreeId, tabId)
  const store = useAppStore.getState()
  const tab = (store.unifiedTabsByWorktree[worktreeId] ?? []).find((item) => item.id === localTabId)
  const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, localTabId)
  // Courtesy chat reveals stay in the current workspace; explicit clicks may navigate.
  if (
    !userInitiated &&
    tab?.contentType === 'agent-session' &&
    store.activeWorktreeId !== worktreeId
  ) {
    return false
  }
  if (!tab) {
    if (browserTarget) {
      // Why: older/mobile fallback snapshots identify browser tabs by workspace id when no unified tab wrapper exists.
      store.setActiveWorktree(worktreeId)
      store.markWorktreeVisited(worktreeId)
      store.setActiveView('terminal')
      store.setActiveBrowserTab(browserTarget.workspaceId)
      store.setActiveTabType('browser', worktreeId)
      store.revealWorktreeInSidebar(worktreeId)
    }
    return false
  }
  store.setActiveWorktree(worktreeId)
  store.markWorktreeVisited(worktreeId)
  store.setActiveView('terminal')
  store.focusGroup(worktreeId, tab.groupId)
  store.activateTab(tab.id)
  if (tab.contentType === 'agent-session') {
    store.setActiveTabType('agent-session', worktreeId)
  } else if (browserTarget) {
    // Why: browser tabs need their own active-page state, not the editor file activation path.
    store.setActiveBrowserTab(browserTarget.workspaceId)
    store.setActiveTabType('browser', worktreeId)
  } else {
    store.setActiveFile(tab.entityId)
    store.setActiveTabType('editor', worktreeId)
  }
  store.revealWorktreeInSidebar(worktreeId)
  return true
}
