import type {
  BrowserSlice,
  BrowserSliceGet,
  BrowserSliceSet,
  ClosedBrowserWorkspaceSnapshot
} from './browser-slice-contract'
import { findWorkspace } from '../browser-page-records'
import { restoreRecentlyClosedTabPosition } from '../recently-closed-tabs'
import { isLocalBrowserPageOwner } from './browser-host-state'
import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { afterPendingEntityTabs, hasPendingEntityTab } from '@/runtime/layout-owner-pending-tabs'

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
      /** The restored record; a layout-owner build's, before main's frame drew it, as proposed. */
      const restoredRecord = (restored: BrowserWorkspace): BrowserWorkspace | null =>
        get().browserTabsByWorktree[worktreeId]?.find((tab) => tab.id === restored.id) ??
        (hasPendingEntityTab(worktreeId, restored.id) ? restored : null)

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
        const position = entryToRestore.position
        // A layout-owner build's tab moves once main's frame drew it.
        afterPendingEntityTabs(worktreeId, restored.id, () =>
          restoreRecentlyClosedTabPosition(get, worktreeId, restored.id, position)
        )
        return restoredRecord(restored)
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

      const position = entryToRestore.position
      const selectRestoredPage = (): void => {
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

        restoreRecentlyClosedTabPosition(get, worktreeId, restored.id, position)
      }
      // A layout-owner build adds the pages once main drew the tab, and selects once it added them.
      afterPendingEntityTabs(worktreeId, restored.id, () => {
        for (const p of restPages) {
          get().createBrowserPage(restored.id, p.url, {
            activate: false,
            title: p.title,
            browserRuntimeEnvironmentId: p.browserRuntimeEnvironmentId,
            ...(p.docLocation ? { docLocation: p.docLocation } : {})
          })
        }
        afterPendingEntityTabs(worktreeId, restored.id, selectRestoredPage)
      })
      return restoredRecord(restored)
    },

    setActiveBrowserTab: (tabId, targetWorktreeId) => {
      set((s) => {
        const browserTab = findWorkspace(s.browserTabsByWorktree, tabId)
        if (!browserTab) {
          return s
        }
        // Why the scope guard: an overlay workspace (the floating panel) activates browser tabs
        // while another workspace owns global selection; moving activeBrowserTabId/activeTabType
        // would break the agent-auto-ack invariant pinned in agent-auto-ack-targets.ts.
        const scopeWorktreeId = targetWorktreeId ?? browserTab.worktreeId
        return {
          ...(scopeWorktreeId === s.activeWorktreeId
            ? { activeBrowserTabId: tabId, activeTabType: 'browser' as const }
            : {}),
          activeBrowserTabIdByWorktree: {
            ...s.activeBrowserTabIdByWorktree,
            [browserTab.worktreeId]: tabId
          },
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
