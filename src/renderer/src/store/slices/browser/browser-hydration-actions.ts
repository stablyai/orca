import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  ORCA_BROWSER_BLANK_URL
} from '../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import type { BrowserSlice, BrowserSliceGet, BrowserSliceSet } from './browser-slice-contract'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace-session-hydration-keys'
import { buildValidWorktreeIdsForSessionHydration } from '../degraded-repo-worktree-validity'
import { destroyWorkspaceWebviews } from '../browser-webview-cleanup'
import { mirrorWorkspaceFromActivePage, normalizeUrl } from '../browser-page-records'
import {
  buildRestoredRemoteBrowserPageHandles,
  getFallbackTabTypeForWorktree
} from './browser-host-state'
import { ensureBrowserClientHostsForRestoredPages } from '@/runtime/restored-client-hosted-browser-host-attach'
import { normalizeBrowserHistoryEntries } from '../../../../../shared/workspace-session-browser-history'
import { normalizeWorkspaceDocHistoryEntries } from '../../../../../shared/workspace-doc-history'

export function createBrowserHydrationActions(
  set: BrowserSliceSet,
  get: BrowserSliceGet
): Pick<BrowserSlice, 'hydrateBrowserSession' | 'switchBrowserTabProfile'> {
  return {
    hydrateBrowserSession: (session, options) => {
      const persistedTabsByWorktree = session.browserTabsByWorktree ?? {}
      const currentState = get()
      const validWorktreeIdsForCleanup = buildValidWorktreeIdsForSessionHydration(
        currentState,
        Object.keys(persistedTabsByWorktree)
      )
      validWorktreeIdsForCleanup.add(FLOATING_TERMINAL_WORKTREE_ID)
      for (const workspace of currentState.folderWorkspaces) {
        validWorktreeIdsForCleanup.add(folderWorkspaceKey(workspace.id))
      }
      addAdditionalValidWorkspaceKeys(validWorktreeIdsForCleanup, options)

      // Why: destroy dropped workspaces' webviews before the pure reducer; no-op today (boot registry empty), defends future re-hydration callers.
      const droppedWorkspaceIds: string[] = []
      for (const [worktreeId, tabs] of Object.entries(persistedTabsByWorktree)) {
        if (!validWorktreeIdsForCleanup.has(worktreeId)) {
          for (const tab of tabs) {
            droppedWorkspaceIds.push(tab.id)
          }
        }
      }
      for (const workspaceId of droppedWorkspaceIds) {
        destroyWorkspaceWebviews(currentState.browserPagesByWorkspace, workspaceId)
      }

      set((s) => {
        const persistedPagesByWorkspace = session.browserPagesByWorkspace ?? {}
        const persistedActiveBrowserTabIdByWorktree = session.activeBrowserTabIdByWorktree ?? {}
        const persistedActiveTabTypeByWorktree = session.activeTabTypeByWorktree ?? {}
        const validWorktreeIds = buildValidWorktreeIdsForSessionHydration(
          s,
          Object.keys(persistedTabsByWorktree)
        )
        validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
        for (const workspace of s.folderWorkspaces) {
          validWorktreeIds.add(folderWorkspaceKey(workspace.id))
        }
        addAdditionalValidWorkspaceKeys(validWorktreeIds, options)

        const browserTabsByWorktree: Record<string, BrowserWorkspace[]> = {}
        const browserPagesByWorkspace: Record<string, BrowserPage[]> = {}

        for (const [worktreeId, tabs] of Object.entries(persistedTabsByWorktree)) {
          if (!validWorktreeIds.has(worktreeId)) {
            continue
          }
          const hydratedTabs: BrowserWorkspace[] = []
          for (const tab of tabs) {
            // Salvage can leave an empty page array; hydrate it like a missing array.
            const storedPages = persistedPagesByWorkspace[tab.id]
            const persistedPages = storedPages?.length
              ? storedPages
              : [
                  {
                    id: createBrowserUuid(),
                    workspaceId: tab.id,
                    worktreeId,
                    url: normalizeUrl(tab.url),
                    title: tab.title,
                    loading: false,
                    faviconUrl: tab.faviconUrl ?? null,
                    canGoBack: tab.canGoBack,
                    canGoForward: tab.canGoForward,
                    loadError: tab.loadError ?? null,
                    createdAt: tab.createdAt,
                    // Why the tab's copy is authority here: this branch runs when the page array was
                    // salvaged away, and without it a restored document page comes back as a blank
                    // New Tab under a strip entry still naming the document.
                    docLocation: tab.docLocation ?? null
                  } satisfies BrowserPage
                ]
            const nextPages = persistedPages.map((page) => {
              // Why: in-memory hydration callers can bypass the persistence schema's unknown-key stripping.
              const { allowWindowClose: _legacyAllowWindowClose, ...persistedPage } =
                page as typeof page & {
                  allowWindowClose?: boolean
                }
              return {
                ...persistedPage,
                workspaceId: tab.id,
                worktreeId,
                // Why re-asserted on restore: the same invariant creation enforces. A session written
                // by an older or hand-edited build could carry a grant URL here, and it would name a
                // grant that died with the process that minted it.
                url: page.docLocation ? ORCA_BROWSER_BLANK_URL : normalizeUrl(page.url),
                loading: false,
                loadError: page.loadError ?? null
              }
            })
            browserPagesByWorkspace[tab.id] = nextPages
            hydratedTabs.push(
              mirrorWorkspaceFromActivePage(
                {
                  ...tab,
                  activePageId: nextPages.some((page) => page.id === tab.activePageId)
                    ? (tab.activePageId ?? nextPages[0]?.id ?? null)
                    : (nextPages[0]?.id ?? null),
                  pageIds: nextPages.map((page) => page.id)
                },
                nextPages
              )
            )
          }
          if (hydratedTabs.length > 0) {
            browserTabsByWorktree[worktreeId] = hydratedTabs
          }
        }

        const validBrowserTabIds = new Set(
          Object.values(browserTabsByWorktree)
            .flat()
            .map((tab) => tab.id)
        )

        const activeBrowserTabIdByWorktree: Record<string, string | null> = {}
        for (const [worktreeId, tabs] of Object.entries(browserTabsByWorktree)) {
          const persistedTabId = persistedActiveBrowserTabIdByWorktree[worktreeId]
          activeBrowserTabIdByWorktree[worktreeId] =
            persistedTabId && validBrowserTabIds.has(persistedTabId)
              ? persistedTabId
              : (tabs[0]?.id ?? null)
        }

        const activeWorktreeId = s.activeWorktreeId
        const activeBrowserTabId =
          activeWorktreeId && activeBrowserTabIdByWorktree[activeWorktreeId]
            ? activeBrowserTabIdByWorktree[activeWorktreeId]
            : null

        const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
        for (const worktreeId of validWorktreeIds) {
          const hasBrowserTabs = (browserTabsByWorktree[worktreeId] ?? []).length > 0
          if (
            persistedActiveTabTypeByWorktree[worktreeId] === 'browser' &&
            hasBrowserTabs &&
            !nextActiveTabTypeByWorktree[worktreeId]
          ) {
            nextActiveTabTypeByWorktree[worktreeId] = 'browser'
            continue
          }
          if (nextActiveTabTypeByWorktree[worktreeId] === 'browser' && !hasBrowserTabs) {
            nextActiveTabTypeByWorktree[worktreeId] = getFallbackTabTypeForWorktree(
              worktreeId,
              s.openFiles,
              s.tabsByWorktree,
              browserTabsByWorktree
            )
          }
        }

        const activeTabType = (() => {
          if (!activeWorktreeId) {
            return s.activeTabType
          }
          const restoredTabType = nextActiveTabTypeByWorktree[activeWorktreeId]
          if (restoredTabType === 'browser' && activeBrowserTabId) {
            return 'browser'
          }
          if (
            restoredTabType === 'editor' &&
            s.openFiles.some((file) => file.worktreeId === activeWorktreeId)
          ) {
            return 'editor'
          }
          return getFallbackTabTypeForWorktree(
            activeWorktreeId,
            s.openFiles,
            s.tabsByWorktree,
            browserTabsByWorktree
          )
        })()

        return {
          browserTabsByWorktree,
          browserPagesByWorkspace,
          activeBrowserTabIdByWorktree,
          activeBrowserTabId,
          activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
          activeTabType,
          remoteBrowserPageHandlesByPageId:
            buildRestoredRemoteBrowserPageHandles(browserPagesByWorkspace),
          browserCertificateFailuresByPageId: {},
          browserAnnotationsByPageId: {},
          browserUrlHistory: normalizeBrowserHistoryEntries(session.browserUrlHistory ?? []),
          workspaceDocHistory: normalizeWorkspaceDocHistoryEntries(
            session.workspaceDocHistory ?? []
          ),
          // Why restored before the rows are: a close the host never heard must outlive the relaunch
          // that also restores the row it closed, or the restore silently wins.
          clientHostedBrowserCloseIntentsByEnvironment:
            session.clientHostedBrowserCloseIntentsByEnvironment ?? {}
        }
      })

      const state = get()
      // Why here and not in the startup chain: the seeded handles are the only record that this
      // desktop was hosting pages, and the runtime only hands them back once it sees an attach.
      void ensureBrowserClientHostsForRestoredPages(state)
      for (const [worktreeId, browserTabs] of Object.entries(state.browserTabsByWorktree)) {
        for (const bt of browserTabs) {
          const exists = (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
            (t) => t.contentType === 'browser' && t.entityId === bt.id
          )
          if (!exists) {
            state.createUnifiedTab(worktreeId, 'browser', {
              entityId: bt.id,
              label: bt.title,
              recordInteraction: false
            })
          }
        }
      }
    },

    switchBrowserTabProfile: (workspaceId, profileId, sessionPartition) => {
      set((s) => {
        for (const [worktreeId, tabs] of Object.entries(s.browserTabsByWorktree)) {
          const tabIndex = tabs.findIndex((t) => t.id === workspaceId)
          if (tabIndex !== -1) {
            const updatedTabs = [...tabs]
            updatedTabs[tabIndex] = {
              ...updatedTabs[tabIndex],
              sessionProfileId: profileId,
              sessionPartition: sessionPartition ?? null
            }
            return {
              browserTabsByWorktree: {
                ...s.browserTabsByWorktree,
                [worktreeId]: updatedTabs
              }
            }
          }
        }
        return {}
      })
    }
  }
}
