import type {
  BrowserSlice,
  BrowserSliceGet,
  BrowserSliceSet,
  RemoteBrowserPageHandle
} from './browser-slice-contract'
import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { findWorkspace } from '../browser-page-records'
import { pickNeighbor } from '../tab-group-state'
import { getRecentlyClosedTabPosition, pushRecentlyClosedTabKind } from '../recently-closed-tabs'
import { getFallbackTabTypeForWorktree, isLocalBrowserPageOwner } from './browser-host-state'
import { closeRemoteBrowserPageInOwningEnvironment } from './browser-remote-close'
import { releaseDocPreviewGrant } from '@/lib/doc-preview-grants'
import { destroyWorkspaceWebviews } from '../browser-webview-cleanup'

export function createBrowserCloseActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'closeBrowserTab' | 'shutdownWorktreeBrowsers'> {
  return {
    closeBrowserTab: (tabId, options) => {
      // Why: a cleanup close unwinds a tab that never finished being created — it owns no host
      // page to close and must not enter the reopen stack as if the user had closed something.
      const isCleanup = options?.reason === 'cleanup'
      let remotePagesToClose: { worktreeId: string; handle: RemoteBrowserPageHandle }[] = []
      // Why collected rather than released inside the reducer: revoking is main-process work, and a
      // grant is the only authority the preview scheme honors — a closed document must stop being
      // readable, and it must stop being readable even if the reducer bails out below.
      let docPageIdsToRelease: string[] = []
      let activeBrowserWorktreeIdToNotify: string | null = null
      set((s) => {
        let owningWorktreeId: string | null = null
        let closedWorkspace: BrowserWorkspace | null = null
        const nextBrowserTabsByWorktree: Record<string, BrowserWorkspace[]> = {}
        for (const [worktreeId, tabs] of Object.entries(s.browserTabsByWorktree)) {
          const removedTab = tabs.find((tab) => tab.id === tabId) ?? null
          const filtered = tabs.filter((tab) => tab.id !== tabId)
          if (filtered.length !== tabs.length) {
            owningWorktreeId = worktreeId
            closedWorkspace = removedTab
          }
          if (filtered.length > 0) {
            nextBrowserTabsByWorktree[worktreeId] = filtered
          }
        }
        if (!owningWorktreeId || !closedWorkspace) {
          return s
        }

        const closedPages = s.browserPagesByWorkspace[tabId] ?? []
        const nextBrowserPagesByWorkspace = { ...s.browserPagesByWorkspace }
        delete nextBrowserPagesByWorkspace[tabId]
        const nextBrowserAnnotationsByPageId = { ...s.browserAnnotationsByPageId }
        const nextBrowserCertificateFailuresByPageId = {
          ...s.browserCertificateFailuresByPageId
        }
        for (const page of closedPages) {
          delete nextBrowserAnnotationsByPageId[page.id]
          delete nextBrowserCertificateFailuresByPageId[page.id]
        }
        docPageIdsToRelease = closedPages.filter((page) => page.docLocation).map((page) => page.id)
        remotePagesToClose = isCleanup
          ? []
          : closedPages.flatMap((page) => {
              const handle = s.remoteBrowserPageHandlesByPageId[page.id]
              return handle ? [{ worktreeId: page.worktreeId, handle }] : []
            })
        const nextRemoteBrowserPageHandlesByPageId = {
          ...s.remoteBrowserPageHandlesByPageId
        }
        for (const page of closedPages) {
          delete nextRemoteBrowserPageHandlesByPageId[page.id]
        }

        const remainingBrowserTabs = nextBrowserTabsByWorktree[owningWorktreeId] ?? []
        const nextActiveBrowserTabIdByWorktree = { ...s.activeBrowserTabIdByWorktree }
        if (nextActiveBrowserTabIdByWorktree[owningWorktreeId] === tabId) {
          const neighborId = pickNeighbor(s.tabBarOrderByWorktree[owningWorktreeId] ?? [], tabId)
          nextActiveBrowserTabIdByWorktree[owningWorktreeId] =
            (neighborId && remainingBrowserTabs.some((tab) => tab.id === neighborId)
              ? neighborId
              : remainingBrowserTabs[0]?.id) ?? null
        }

        const nextTabBarOrder = {
          ...s.tabBarOrderByWorktree,
          [owningWorktreeId]: (s.tabBarOrderByWorktree[owningWorktreeId] ?? []).filter(
            (entryId) => entryId !== tabId
          )
        }

        const isActiveTabInOwningWorktree =
          s.activeWorktreeId === owningWorktreeId && s.activeBrowserTabId === tabId
        if (isActiveTabInOwningWorktree) {
          activeBrowserWorktreeIdToNotify = owningWorktreeId
        }
        const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
        let nextActiveTabType = s.activeTabType
        if (remainingBrowserTabs.length === 0) {
          const fallbackTabType = getFallbackTabTypeForWorktree(
            owningWorktreeId,
            s.openFiles,
            s.tabsByWorktree
          )
          nextActiveTabTypeByWorktree[owningWorktreeId] = fallbackTabType
          if (isActiveTabInOwningWorktree && s.activeTabType === 'browser') {
            nextActiveTabType = fallbackTabType
          }
        }

        const nextRecentlyClosedBrowserTabsByWorktree = { ...s.recentlyClosedBrowserTabsByWorktree }
        if (!isCleanup) {
          const existingSnapshots = nextRecentlyClosedBrowserTabsByWorktree[owningWorktreeId] ?? []
          const position = getRecentlyClosedTabPosition(s, owningWorktreeId, tabId)
          nextRecentlyClosedBrowserTabsByWorktree[owningWorktreeId] = [
            {
              workspace: closedWorkspace,
              pages: closedPages,
              ...(position ? { position } : {})
            },
            ...existingSnapshots.filter((entry) => entry.workspace.id !== closedWorkspace.id)
          ].slice(0, 10)
        }
        const nextRecentlyClosedTabKindsByWorktree = isCleanup
          ? s.recentlyClosedTabKindsByWorktree
          : pushRecentlyClosedTabKind(
              s.recentlyClosedTabKindsByWorktree,
              owningWorktreeId,
              'browser'
            )

        const nextRecentlyClosedBrowserPagesByWorkspace = {
          ...s.recentlyClosedBrowserPagesByWorkspace
        }
        delete nextRecentlyClosedBrowserPagesByWorkspace[tabId]

        const nextPendingAddressBarFocusByPageId = Object.fromEntries(
          Object.entries(s.pendingAddressBarFocusByPageId).filter(
            ([pageId]) => !closedPages.some((page) => page.id === pageId)
          )
        )
        const nextPendingAddressBarFocusByTabId = Object.fromEntries(
          Object.entries(s.pendingAddressBarFocusByTabId).filter(
            ([focusId]) => focusId !== tabId && !closedPages.some((page) => page.id === focusId)
          )
        )

        return {
          browserTabsByWorktree: nextBrowserTabsByWorktree,
          browserPagesByWorkspace: nextBrowserPagesByWorkspace,
          activeBrowserTabId:
            s.activeBrowserTabId === tabId
              ? (nextActiveBrowserTabIdByWorktree[owningWorktreeId] ?? null)
              : s.activeBrowserTabId,
          activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree,
          tabBarOrderByWorktree: nextTabBarOrder,
          activeTabType: nextActiveTabType,
          pendingAddressBarFocusByPageId: nextPendingAddressBarFocusByPageId,
          pendingAddressBarFocusByTabId: nextPendingAddressBarFocusByTabId,
          activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
          recentlyClosedBrowserTabsByWorktree: nextRecentlyClosedBrowserTabsByWorktree,
          recentlyClosedTabKindsByWorktree: nextRecentlyClosedTabKindsByWorktree,
          recentlyClosedBrowserPagesByWorkspace: nextRecentlyClosedBrowserPagesByWorkspace,
          remoteBrowserPageHandlesByPageId: nextRemoteBrowserPageHandlesByPageId,
          browserCertificateFailuresByPageId: nextBrowserCertificateFailuresByPageId,
          browserAnnotationsByPageId: nextBrowserAnnotationsByPageId
        }
      })

      for (const remotePage of remotePagesToClose) {
        closeRemoteBrowserPageInOwningEnvironment(
          remotePage.worktreeId,
          remotePage.handle,
          get().recordClientHostedBrowserCloseIntents
        )
      }

      for (const docPageId of docPageIdsToRelease) {
        releaseDocPreviewGrant(docPageId)
      }

      for (const tabs of Object.values(get().unifiedTabsByWorktree)) {
        const workspaceItem = tabs.find(
          (entry) => entry.contentType === 'browser' && entry.entityId === tabId
        )
        if (workspaceItem) {
          get().closeUnifiedTab(
            workspaceItem.id,
            isCleanup ? { preserveWorktreeSelection: true, recordInteraction: false } : undefined
          )
        }
      }

      // Why: announce the MRU page before guest teardown so bridge fallback cannot choose registration order.
      if (activeBrowserWorktreeIdToNotify) {
        const state = get()
        const activeWorkspaceId =
          state.activeBrowserTabIdByWorktree[activeBrowserWorktreeIdToNotify]
        const activeWorkspace = activeWorkspaceId
          ? findWorkspace(state.browserTabsByWorktree, activeWorkspaceId)
          : null
        const activePage = activeWorkspace?.activePageId
          ? (state.browserPagesByWorkspace[activeWorkspace.id] ?? []).find(
              (page) => page.id === activeWorkspace.activePageId
            )
          : undefined
        if (
          activeWorkspace?.activePageId &&
          isLocalBrowserPageOwner(
            state,
            activeBrowserWorktreeIdToNotify,
            activePage?.browserRuntimeEnvironmentId
          ) &&
          typeof window !== 'undefined' &&
          window.api?.browser
        ) {
          window.api.browser
            .notifyActiveTabChanged({ browserPageId: activeWorkspace.activePageId })
            .catch(() => {})
        }
      }
    },

    shutdownWorktreeBrowsers: async (worktreeId) => {
      const workspaces = get().browserTabsByWorktree[worktreeId] ?? []
      // Why: snapshot before the loop — closeBrowserTab empties the array, so set() below couldn't recompute hadBrowserTabs.
      const hadBrowserTabs = workspaces.length > 0
      for (const workspace of workspaces) {
        const browserPagesByWorkspace = get().browserPagesByWorkspace
        get().closeBrowserTab(workspace.id)
        destroyWorkspaceWebviews(browserPagesByWorkspace, workspace.id)
      }
      set((s) => {
        const nextBrowserTabsByWorktree = { ...s.browserTabsByWorktree }
        delete nextBrowserTabsByWorktree[worktreeId]
        const nextActiveBrowserTabIdByWorktree = { ...s.activeBrowserTabIdByWorktree }
        delete nextActiveBrowserTabIdByWorktree[worktreeId]
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
}
