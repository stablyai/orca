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
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'
import { landOnEmptiedWorktree } from '../tabs/tabs-close-actions'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { forgetDesktopCreatedServerTab } from '@/lib/desktop-created-server-tabs'
import {
  closeBrowserTabThroughLayoutOwner,
  withDrawnBrowserPages,
  type DrawnBrowserTab
} from './browser-tab-close-through-layout-owner'

export function createBrowserCloseActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'closeBrowserTab' | 'shutdownWorktreeBrowsers'> {
  return {
    closeBrowserTab: (tabId, options) => {
      forgetDesktopCreatedServerTab(tabId)
      // Cleanup unwinds unfinished creation: no host page close and no user reopen history.
      const isCleanup = options?.reason === 'cleanup'
      const closeHere = (drawn?: DrawnBrowserTab): void => {
        let remotePagesToClose: { worktreeId: string; handle: RemoteBrowserPageHandle }[] = []
        // Collect grants outside reducer: revocation is main work and closed docs must become unreadable even if reduction bails.
        let docPageIdsToRelease: string[] = []
        let activeBrowserWorktreeIdToNotify: string | null = null
        set((current) => {
          const s = drawn ? withDrawnBrowserPages(current, drawn) : current
          // Main's frame already dropped a drawn tab's record.
          let owningWorktreeId: string | null = drawn?.worktreeId ?? null
          let closedWorkspace: BrowserWorkspace | null = drawn?.record ?? null
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
            return current
          }

          const closedPages = s.browserPagesByWorkspace[tabId] ?? []
          const nextBrowserPagesByWorkspace = { ...s.browserPagesByWorkspace }
          delete nextBrowserPagesByWorkspace[tabId]
          const nextBrowserAnnotationsByPageId = { ...s.browserAnnotationsByPageId }
          const nextBrowserAnnotationMarkerIdsByPageId = { ...s.browserAnnotationMarkerIdsByPageId }
          const nextBrowserCertificateFailuresByPageId = {
            ...s.browserCertificateFailuresByPageId
          }
          for (const page of closedPages) {
            delete nextBrowserAnnotationsByPageId[page.id]
            delete nextBrowserAnnotationMarkerIdsByPageId[page.id]
            delete nextBrowserCertificateFailuresByPageId[page.id]
          }
          docPageIdsToRelease = closedPages
            .filter((page) => page.docLocation)
            .map((page) => page.id)
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

          const nextRecentlyClosedBrowserTabsByWorktree = {
            ...s.recentlyClosedBrowserTabsByWorktree
          }
          if (!isCleanup) {
            const existingSnapshots =
              nextRecentlyClosedBrowserTabsByWorktree[owningWorktreeId] ?? []
            const position = drawn
              ? drawn.position
              : getRecentlyClosedTabPosition(s, owningWorktreeId, tabId)
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

          // Omit only closed IDs; avoid rebuilding every pending entry and preserve no-op identity.
          const closedPageIds = closedPages.map((page) => page.id)
          const nextPendingAddressBarFocusByPageId = omitRecordKeys(
            s.pendingAddressBarFocusByPageId,
            closedPageIds
          )
          const nextPendingAddressBarFocusByTabId = omitRecordKeys(
            s.pendingAddressBarFocusByTabId,
            [...closedPageIds, tabId]
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
            browserAudioMutedTabIds: omitRecordKeys(s.browserAudioMutedTabIds, [tabId]),
            browserAnnotationsByPageId: nextBrowserAnnotationsByPageId,
            browserAnnotationMarkerIdsByPageId: nextBrowserAnnotationMarkerIdsByPageId
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

        // Main's frame already dropped a drawn tab's entry.
        for (const tabs of drawn ? [] : Object.values(get().unifiedTabsByWorktree)) {
          const workspaceItem = tabs.find(
            (entry) => entry.contentType === 'browser' && entry.entityId === tabId
          )
          if (workspaceItem) {
            get().closeUnifiedTab(
              workspaceItem.id,
              isCleanup
                ? { preserveWorktreeSelection: true, recordInteraction: false }
                : options?.preserveWorktreeSelection
                  ? { preserveWorktreeSelection: true }
                  : undefined
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
      }
      // Switch point: main closes the tab first; today's close then runs over the tab as drawn.
      const owningWorktreeId = ORCA_LAYOUT_OWNER_IS_MAIN
        ? findWorkspace(get().browserTabsByWorktree, tabId)?.worktreeId
        : undefined
      if (
        ORCA_LAYOUT_OWNER_IS_MAIN &&
        closeBrowserTabThroughLayoutOwner(
          get,
          tabId,
          isCleanup ? 'cleanup' : 'user',
          (drawn) => closeHere(drawn),
          // As today's tab-bar close: a cleanup keeps the selection and counts no interaction.
          isCleanup || options?.preserveWorktreeSelection || !owningWorktreeId
            ? undefined
            : () => landOnEmptiedWorktree(set, get, owningWorktreeId)
        )
      ) {
        if (!isCleanup) {
          get().recordFeatureInteraction?.('terminal-tabs')
        }
        return
      }
      closeHere()
    },

    shutdownWorktreeBrowsers: (worktreeId, options) => {
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
        const nextBrowserTabsByWorktree = omitRecordKeys(
          s.browserTabsByWorktree,
          removedWorktreeIds
        )
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
}
