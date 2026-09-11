import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import { mirrorWorkspaceFromActivePage } from '../browser-page-records'
import { isLocalBrowserPageOwner } from './browser-host-state'

export function createBrowserPageFocusActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'focusBrowserTabInWorktree' | 'consumeAddressBarFocusRequest'> {
  return {
    focusBrowserTabInWorktree: (worktreeId, browserPageId, options) => {
      // Why: bridge targets a browserPageId but tabs activate a workspace; find the owning workspace (they differ for multi-page tabs).
      const tabsForWorktree = get().browserTabsByWorktree[worktreeId] ?? []
      const workspace = tabsForWorktree.find((tab) => (tab.pageIds ?? []).includes(browserPageId))
      if (!workspace) {
        // Best-effort: worktree state may not be hydrated yet, or the page closed between bridge switch and this IPC arriving.
        return
      }
      // Default true: the only caller (tab switch --focus) wants the pane surfaced; false is an opt-out for pre-staging callers.
      const surfacePane = options?.surfacePane ?? true
      const pages = get().browserPagesByWorkspace[workspace.id] ?? []
      const nextWorkspace = mirrorWorkspaceFromActivePage(
        { ...workspace, activePageId: browserPageId },
        pages
      )
      // TODO: duplicates setActiveBrowserTab/Page; can't reuse (they touch globals unconditionally). Extract a per-worktree-only helper.
      set((s) => {
        const isActiveWorktree = s.activeWorktreeId === worktreeId
        // Per-worktree slots: always update — safe pre-staging, only visible when user navigates here.
        const nextTabsByWorktree = {
          ...s.browserTabsByWorktree,
          [worktreeId]: tabsForWorktree.map((tab) =>
            tab.id === workspace.id ? nextWorkspace : tab
          )
        }
        const nextActiveTabIdByWorktree = {
          ...s.activeBrowserTabIdByWorktree,
          [worktreeId]: workspace.id
        }
        const nextActiveTabTypeByWorktree = surfacePane
          ? { ...s.activeTabTypeByWorktree, [worktreeId]: 'browser' as const }
          : s.activeTabTypeByWorktree
        // Globals: mutate only when the targeted worktree is active — keeps cross-worktree --focus silent.
        return {
          browserTabsByWorktree: nextTabsByWorktree,
          activeBrowserTabIdByWorktree: nextActiveTabIdByWorktree,
          activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
          activeBrowserTabId: isActiveWorktree ? workspace.id : s.activeBrowserTabId,
          activeTabType: isActiveWorktree && surfacePane ? 'browser' : s.activeTabType
        }
      })

      // Why: notify the CDP bridge which guest webContents is active so agent commands target the correct page.
      const focusedPage = pages.find((page) => page.id === browserPageId)
      if (
        isLocalBrowserPageOwner(get(), worktreeId, focusedPage?.browserRuntimeEnvironmentId) &&
        typeof window !== 'undefined' &&
        window.api?.browser
      ) {
        window.api.browser.notifyActiveTabChanged({ browserPageId }).catch(() => {})
      }

      // Why: sync the unified-tab strip's active entry; activateTab only mutates per-worktree slices, so it's cross-worktree-safe.
      const item = (get().unifiedTabsByWorktree[worktreeId] ?? []).find(
        (entry) => entry.contentType === 'browser' && entry.entityId === workspace.id
      )
      if (item) {
        get().activateTab(item.id)
      }
    },

    consumeAddressBarFocusRequest: (pageId) => {
      const state = get()
      if (
        !state.pendingAddressBarFocusByPageId[pageId] &&
        !state.pendingAddressBarFocusByTabId[pageId]
      ) {
        return false
      }

      set((s) => {
        const nextByPageId = { ...s.pendingAddressBarFocusByPageId }
        delete nextByPageId[pageId]
        const nextByTabId = { ...s.pendingAddressBarFocusByTabId }
        delete nextByTabId[pageId]
        return {
          pendingAddressBarFocusByPageId: nextByPageId,
          pendingAddressBarFocusByTabId: nextByTabId
        }
      })

      return true
    }
  }
}
