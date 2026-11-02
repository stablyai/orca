import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session-state-types'
import { normalizeBrowserHistoryEntries } from '../../../../../shared/workspace-session-browser-history'
import { normalizeWorkspaceDocHistoryEntries } from '../../../../../shared/workspace-doc-history'
import type { AppState } from '../../types'
import { mirrorWorkspaceFromActivePage, normalizeUrl } from '../browser-page-records'
import {
  buildRestoredRemoteBrowserPageHandles,
  getFallbackTabTypeForWorktree
} from './browser-host-state'

/** The browser state a stored session restores, given what the earlier hydration steps wrote. */
export function projectHydratedBrowserSession(
  s: Pick<
    AppState,
    | 'activeWorktreeId'
    | 'activeTabType'
    | 'activeTabTypeByWorktree'
    | 'openFiles'
    | 'tabsByWorktree'
  >,
  session: WorkspaceSessionState,
  validWorktreeIds: ReadonlySet<string>,
  /** A workspace with no remembered browser tab keeps none, instead of restoring its first. */
  options: { unchosenStaysUnset?: true } = {}
) {
  const persistedTabsByWorktree = session.browserTabsByWorktree ?? {}
  const persistedPagesByWorkspace = session.browserPagesByWorkspace ?? {}
  const persistedActiveBrowserTabIdByWorktree = session.activeBrowserTabIdByWorktree ?? {}
  const persistedActiveTabTypeByWorktree = session.activeTabTypeByWorktree ?? {}
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
              // Switch point: a frame names the page before its record lands; keep that id stable.
              id:
                (ORCA_LAYOUT_OWNER_IS_MAIN ? (tab.activePageId ?? tab.pageIds?.[0]) : undefined) ??
                createBrowserUuid(),
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
              // Salvaged-away page arrays recover document identity from tab chrome or restore blank New Tabs beneath stale labels.
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
          // Reassert creation’s URL fence for old/handwritten sessions; persisted grants died with their originating process.
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
        : !persistedTabId && options.unchosenStaysUnset
          ? null
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
    browserAnnotationMarkerIdsByPageId: {},
    browserUrlHistory: normalizeBrowserHistoryEntries(session.browserUrlHistory ?? []),
    workspaceDocHistory: normalizeWorkspaceDocHistoryEntries(session.workspaceDocHistory ?? []),
    // Restore undelivered closes before rows or relaunch silently resurrects the pages they hide.
    clientHostedBrowserCloseIntentsByEnvironment:
      session.clientHostedBrowserCloseIntentsByEnvironment ?? {}
  }
}
