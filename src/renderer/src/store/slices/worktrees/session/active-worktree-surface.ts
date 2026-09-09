import type { AppState } from '../../../types'
import type { WorkspaceVisibleTabType } from '../../../../../../shared/tab-types'
import { toVisibleTabType } from '../../../../../../shared/tab-types'

export function resolveActivatedWorktreeSurface(
  s: AppState,
  worktreeId: string,
  preferredActiveUnifiedTabId: string | undefined,
  reconciledActiveTabId: string | null
): {
  restoredRightSidebarExplorerView: NonNullable<
    AppState['rightSidebarExplorerViewByWorktree']
  >[string]
  activeFileId: string | null
  activeBrowserTabId: string | null
  activeTabType: WorkspaceVisibleTabType
  activeTabId: string | null
} {
  // Why: Search lives under Explorer, so the files/search sub-route must switch with the worktree, not leak the prior one.
  const restoredRightSidebarExplorerView =
    s.rightSidebarExplorerViewByWorktree?.[worktreeId] ?? 'files'
  const restoredFileId = s.activeFileIdByWorktree[worktreeId] ?? null
  const restoredBrowserTabId = s.activeBrowserTabIdByWorktree[worktreeId] ?? null
  const restoredTabType = s.activeTabTypeByWorktree[worktreeId] ?? 'terminal'
  const activeGroupId =
    s.activeGroupIdByWorktree[worktreeId] ?? s.groupsByWorktree[worktreeId]?.[0]?.id ?? null
  const activeGroup = activeGroupId
    ? ((s.groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId) ?? null)
    : null
  const activeUnifiedTabId =
    preferredActiveUnifiedTabId ?? reconciledActiveTabId ?? activeGroup?.activeTabId ?? null
  const activeUnifiedTab =
    activeUnifiedTabId != null
      ? ((s.unifiedTabsByWorktree[worktreeId] ?? []).find(
          (tab) => tab.id === activeUnifiedTabId && (!activeGroup || tab.groupId === activeGroup.id)
        ) ?? null)
      : null
  // Verify the restored file still exists in openFiles
  const fileStillOpen = restoredFileId
    ? s.openFiles.some((f) => f.id === restoredFileId && f.worktreeId === worktreeId)
    : false
  const browserTabs = s.browserTabsByWorktree[worktreeId] ?? []
  const browserTabStillOpen = restoredBrowserTabId
    ? browserTabs.some((tab) => tab.id === restoredBrowserTabId)
    : false
  const hasGroupOwnedSurface =
    (s.groupsByWorktree[worktreeId]?.length ?? 0) > 0 || Boolean(s.layoutByWorktree[worktreeId])

  // Why: restore from the reconciled tab-group model first; preferring legacy fallbacks can show a blank worktree.
  let activeFileId: string | null
  let activeBrowserTabId: string | null
  let activeTabType: WorkspaceVisibleTabType
  if (activeUnifiedTab) {
    activeFileId =
      activeUnifiedTab.contentType === 'editor' ||
      activeUnifiedTab.contentType === 'diff' ||
      activeUnifiedTab.contentType === 'conflict-review' ||
      activeUnifiedTab.contentType === 'check-details'
        ? activeUnifiedTab.entityId
        : fileStillOpen
          ? restoredFileId
          : null
    activeBrowserTabId =
      activeUnifiedTab.contentType === 'browser'
        ? activeUnifiedTab.entityId
        : browserTabStillOpen
          ? restoredBrowserTabId
          : (browserTabs[0]?.id ?? null)
    activeTabType = toVisibleTabType(activeUnifiedTab.contentType)
  } else if (hasGroupOwnedSurface) {
    activeFileId = fileStillOpen ? restoredFileId : null
    activeBrowserTabId = browserTabStillOpen ? restoredBrowserTabId : (browserTabs[0]?.id ?? null)
    activeTabType = 'terminal'
  } else if (restoredTabType === 'terminal') {
    activeFileId = fileStillOpen ? restoredFileId : null
    activeBrowserTabId = browserTabStillOpen ? restoredBrowserTabId : (browserTabs[0]?.id ?? null)
    activeTabType = 'terminal'
  } else if (restoredTabType === 'browser' && browserTabStillOpen) {
    activeFileId = fileStillOpen ? restoredFileId : null
    activeBrowserTabId = restoredBrowserTabId
    activeTabType = 'browser'
  } else if (restoredTabType === 'editor' && fileStillOpen) {
    activeFileId = restoredFileId
    activeBrowserTabId = browserTabStillOpen ? restoredBrowserTabId : (browserTabs[0]?.id ?? null)
    activeTabType = 'editor'
  } else if (browserTabStillOpen) {
    activeFileId = null
    activeBrowserTabId = restoredBrowserTabId
    activeTabType = 'browser'
  } else if (fileStillOpen) {
    activeFileId = restoredFileId
    activeBrowserTabId = browserTabs[0]?.id ?? null
    activeTabType = 'editor'
  } else {
    const fallbackFile = s.openFiles.find((f) => f.worktreeId === worktreeId)
    const fallbackBrowserTab = browserTabs[0] ?? null
    activeFileId = fallbackFile?.id ?? null
    activeBrowserTabId = browserTabStillOpen
      ? restoredBrowserTabId
      : (fallbackBrowserTab?.id ?? null)
    activeTabType = fallbackFile ? 'editor' : fallbackBrowserTab ? 'browser' : 'terminal'
  }

  // Why: restore the last-active terminal tab so the user returns to where they left, not tab 0.
  const restoredTabId = s.activeTabIdByWorktree[worktreeId] ?? null
  const worktreeTabs = s.tabsByWorktree[worktreeId] ?? []
  const tabStillExists = restoredTabId ? worktreeTabs.some((t) => t.id === restoredTabId) : false
  const activeTabId =
    activeUnifiedTab?.contentType === 'terminal'
      ? activeUnifiedTab.entityId
      : tabStillExists
        ? restoredTabId
        : (worktreeTabs[0]?.id ?? null)

  return {
    restoredRightSidebarExplorerView,
    activeFileId,
    activeBrowserTabId,
    activeTabType,
    activeTabId
  }
}
