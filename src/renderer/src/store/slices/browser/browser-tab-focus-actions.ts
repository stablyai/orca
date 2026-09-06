import type {
  BrowserSlice,
  BrowserSliceGet,
  BrowserSliceSet,
  ClosedBrowserWorkspaceSnapshot
} from './browser-slice-contract'
import { findWorkspace } from '../browser-page-records'
import { restoreRecentlyClosedTabPosition } from '../recently-closed-tabs'
import { isLocalBrowserPageOwner } from './browser-host-state'

export function createBrowserTabFocusActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'reopenClosedBrowserTab' | 'setActiveBrowserTab'> {
  return {
    reopenClosedBrowserTab: (worktreeId) => {
      // Why: read and pop atomically inside set() so two rapid Cmd+Shift+T presses can't both restore the same entry (TOCTOU).
      let entryToRestore: ClosedBrowserWorkspaceSnapshot | undefined

      set((s) => {
        const recentlyClosed = s.recentlyClosedBrowserTabsByWorktree[worktreeId] ?? []
        entryToRestore = recentlyClosed[0]
        if (!entryToRestore) {
          return s
        }
        return {
          recentlyClosedBrowserTabsByWorktree: {
            ...s.recentlyClosedBrowserTabsByWorktree,
            [worktreeId]: recentlyClosed.slice(1)
          }
        }
      })

      if (!entryToRestore) {
        return null
      }

      const snap = entryToRestore.workspace
      const pages = entryToRestore.pages
      const sessionProfileId = snap.sessionProfileId ?? null
      const sessionPartition = snap.sessionPartition ?? null

      if (pages.length === 0) {
        const restored = get().createBrowserTab(worktreeId, snap.url, {
          title: snap.title,
          activate: true,
          sessionProfileId,
          sessionPartition,
          ...(snap.docLocation ? { docLocation: snap.docLocation } : {}),
          targetGroupId: entryToRestore.position?.groupId
        })
        restoreRecentlyClosedTabPosition(get, worktreeId, restored.id, entryToRestore.position)
        return (
          get().browserTabsByWorktree[worktreeId]?.find((tab) => tab.id === restored.id) ?? null
        )
      }

      // Why: append remaining pages in original order so multi-page workspaces preserve their page sequence.
      const [firstPage, ...restPages] = pages
      const restored = get().createBrowserTab(worktreeId, firstPage.url, {
        title: firstPage.title,
        activate: true,
        sessionProfileId,
        sessionPartition,
        targetGroupId: entryToRestore.position?.groupId,
        browserRuntimeEnvironmentId: firstPage.browserRuntimeEnvironmentId,
        ...(firstPage.docLocation ? { docLocation: firstPage.docLocation } : {})
      })

      for (const p of restPages) {
        get().createBrowserPage(restored.id, p.url, {
          activate: false,
          title: p.title,
          browserRuntimeEnvironmentId: p.browserRuntimeEnvironmentId,
          ...(p.docLocation ? { docLocation: p.docLocation } : {})
        })
      }

      // Why: duplicate URLs are valid, so matching by URL can pick the wrong copy; restore preserves order, so map by index.
      const activePageId = snap.activePageId
      if (activePageId) {
        const restoredPages = get().browserPagesByWorkspace[restored.id] ?? []
        const activePageIndex = pages.findIndex((orig) => orig.id === activePageId)
        const targetPage = activePageIndex !== -1 ? restoredPages[activePageIndex] : null
        if (targetPage && targetPage.id !== restoredPages[0]?.id) {
          get().setActiveBrowserPage(restored.id, targetPage.id)
        }
      }

      restoreRecentlyClosedTabPosition(get, worktreeId, restored.id, entryToRestore.position)

      return get().browserTabsByWorktree[worktreeId]?.find((tab) => tab.id === restored.id) ?? null
    },

    setActiveBrowserTab: (tabId) => {
      set((s) => {
        const browserTab = findWorkspace(s.browserTabsByWorktree, tabId)
        if (!browserTab) {
          return s
        }
        return {
          activeBrowserTabId: tabId,
          activeBrowserTabIdByWorktree: {
            ...s.activeBrowserTabIdByWorktree,
            [browserTab.worktreeId]: tabId
          },
          activeTabType: 'browser',
          activeTabTypeByWorktree: {
            ...s.activeTabTypeByWorktree,
            [browserTab.worktreeId]: 'browser'
          }
        }
      })

      // Why: notify the CDP bridge of the active guest; it keys on page IDs not workspace IDs, so resolve the workspace's active page.
      const workspace = findWorkspace(get().browserTabsByWorktree, tabId)
      const activePage = workspace?.activePageId
        ? (get().browserPagesByWorkspace[workspace.id] ?? []).find(
            (page) => page.id === workspace.activePageId
          )
        : undefined
      if (
        workspace?.activePageId &&
        isLocalBrowserPageOwner(
          get(),
          workspace.worktreeId,
          activePage?.browserRuntimeEnvironmentId
        ) &&
        typeof window !== 'undefined' &&
        window.api?.browser
      ) {
        window.api.browser
          .notifyActiveTabChanged({ browserPageId: workspace.activePageId })
          .catch(() => {})
      }

      const item = Object.values(get().unifiedTabsByWorktree)
        .flat()
        .find((entry) => entry.contentType === 'browser' && entry.entityId === tabId)
      if (item) {
        get().activateTab(item.id)
      }
    }
  }
}
