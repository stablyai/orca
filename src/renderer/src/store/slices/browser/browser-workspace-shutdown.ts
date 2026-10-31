import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import { destroyWorkspaceWebviews } from '../browser-webview-cleanup'
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'

export function createBrowserWorkspaceShutdown(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): BrowserSlice['shutdownWorktreeBrowsers'] {
  return (worktreeId, options) => {
    const workspaces = get().browserTabsByWorktree[worktreeId] ?? []
    // Why: snapshot before the loop — closeBrowserTab empties the array, so set() below couldn't recompute hadBrowserTabs.
    const hadBrowserTabs = workspaces.length > 0
    for (const workspace of workspaces) {
      const browserPagesByWorkspace = get().browserPagesByWorkspace
      get().closeBrowserTab(workspace.id, options)
      destroyWorkspaceWebviews(browserPagesByWorkspace, workspace.id)
    }
    set((s) => {
      const removedWorktreeIds = [worktreeId]
      const nextBrowserTabsByWorktree = omitRecordKeys(s.browserTabsByWorktree, removedWorktreeIds)
      const nextActiveBrowserTabIdByWorktree = omitRecordKeys(
        s.activeBrowserTabIdByWorktree,
        removedWorktreeIds
      )
      // Why: reset the global browser surface only when the shut-down worktree is the active one AND had tabs.
      const shouldResetGlobalBrowser = s.activeWorktreeId === worktreeId && hadBrowserTabs
      return {
        browserTabsByWorktree: nextBrowserTabsByWorktree,
        activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree,
        ...(shouldResetGlobalBrowser
          ? { activeBrowserTabId: null, activeTabType: 'terminal' as const }
          : {})
      }
    })
  }
}
