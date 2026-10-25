import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionTabsResult
} from '../../../../shared/runtime-types'
import type { BrowserPage, BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { Tab } from '../../../../shared/tab-types'
import type { WebSessionTabsSyncState, MirroredBrowserTab } from './state'
import { readBrowserClientHostId } from '../browser-client-host-identity'
import { peekWebSessionBrowserPlacementGroup } from '../web-session-browser-placement'
import { browserPageEqual } from './state-equality-tabs'
import { sameStringArray } from './state-equality-core'
import { collectLayoutGroupIds } from './tab-group-layout-tree'
import { buildBrowserUnifiedTab } from './tab-builders'
import { isReadyBrowserTab } from './terminal-surfaces'

export function findBrowserWorkspaceForRemotePage(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  environmentId: string,
  remotePageId: string
): { workspace: BrowserWorkspace; page: BrowserPage; unifiedTab: Tab | null } | null {
  const workspaces = state.browserTabsByWorktree[worktreeId] ?? []
  for (const workspace of workspaces) {
    const pages = state.browserPagesByWorkspace[workspace.id] ?? []
    for (const page of pages) {
      const handle = state.remoteBrowserPageHandlesByPageId[page.id]
      if (handle?.environmentId === environmentId && handle.remotePageId === remotePageId) {
        return {
          workspace,
          page,
          unifiedTab:
            (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
              (tab) => tab.contentType === 'browser' && tab.entityId === workspace.id
            ) ?? null
        }
      }
    }
  }
  return null
}

export function browserWorkspaceHasRemoteEnvironmentPage(
  state: WebSessionTabsSyncState,
  workspace: BrowserWorkspace,
  environmentId: string
): boolean {
  return (state.browserPagesByWorkspace[workspace.id] ?? []).some(
    (page) => state.remoteBrowserPageHandlesByPageId[page.id]?.environmentId === environmentId
  )
}

/** A page of this environment whose guest runs on this desktop, so it survives the host process. */
export function browserWorkspaceHasClientHostedEnvironmentPage(
  state: WebSessionTabsSyncState,
  workspace: BrowserWorkspace,
  environmentId: string
): boolean {
  return (state.browserPagesByWorkspace[workspace.id] ?? []).some((page) => {
    const handle = state.remoteBrowserPageHandlesByPageId[page.id]
    return (
      handle?.environmentId === environmentId &&
      (handle.placement?.kind === 'client' ||
        handle.stagedClientHosted === true ||
        handle.restoredClientHosted === true)
    )
  })
}

/** Retain local title against host URL/Browser fallbacks only while URL matches. Covers staged, server-driven and other-client mirrors; our own guest rows bypass this via resolveMirroredBrowserPageContent. */
export function resolveMirroredBrowserTitle(
  tab: RuntimeMobileSessionBrowserTab,
  existingPage: BrowserPage | undefined
): string {
  const published = tab.title.trim()
  const publishedIsHostFallback =
    published === '' || published === tab.url.trim() || published === 'Browser'
  if (existingPage && publishedIsHostFallback && tab.url === existingPage.url) {
    return existingPage.title
  }
  return published || 'Browser'
}

/** Only exact placement lease-holder identity proves this client hosts the guest; client kind alone includes other desktops/web. Ownership starts before attachment to prevent first-snapshot title flicker. */
export function clientHostsMirroredBrowserPage(tab: RuntimeMobileSessionBrowserTab): boolean {
  if (tab.placement?.kind !== 'client') {
    return false
  }
  const hostClientId = readBrowserClientHostId()
  return hostClientId !== null && tab.placement.browserHostClientId === hostClientId
}

/** Our guest row owns content; host metadata is delayed echo/create defaults. Rewinding URL also defeats staged-title matching next frame. Other clients have no guest evidence and must follow host content rather than freeze their first snapshot. */
export function resolveMirroredBrowserPageContent(
  tab: RuntimeMobileSessionBrowserTab,
  existingPage: BrowserPage | undefined
): Pick<BrowserPage, 'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward'> {
  if (clientHostsMirroredBrowserPage(tab) && existingPage) {
    return {
      url: existingPage.url,
      title: existingPage.title,
      loading: existingPage.loading,
      canGoBack: existingPage.canGoBack,
      canGoForward: existingPage.canGoForward
    }
  }
  return {
    url: tab.url,
    title: resolveMirroredBrowserTitle(tab, existingPage),
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward
  }
}

export function buildMirroredBrowserTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  state: WebSessionTabsSyncState,
  hostGroupIdByTabId: ReadonlyMap<string, string>,
  fallbackGroupId: string,
  sortOffset: number,
  now: number
): MirroredBrowserTab[] {
  const renderedGroupIds = collectLayoutGroupIds(state.layoutByWorktree[snapshot.worktree])
  const clientGroupIds = new Set(
    (state.groupsByWorktree[snapshot.worktree] ?? []).map((group) => group.id)
  )
  return snapshot.tabs.filter(isReadyBrowserTab).map((tab, index) => {
    const existing = findBrowserWorkspaceForRemotePage(
      state,
      snapshot.worktree,
      environmentId,
      tab.browserPageId
    )
    const workspaceId = existing?.workspace.id ?? tab.browserWorkspaceId
    const pageId = existing?.page.id ?? tab.browserPageId
    const createdAt = existing?.page.createdAt ?? now + sortOffset + index
    const recordedClientGroupId = peekWebSessionBrowserPlacementGroup({
      environmentId,
      worktreeId: snapshot.worktree,
      remotePageId: tab.browserPageId
    })
    const hostGroupId = hostGroupIdByTabId.get(tab.id) ?? fallbackGroupId
    const existingClientGroupId =
      existing?.unifiedTab?.groupId !== hostGroupId ? existing?.unifiedTab?.groupId : undefined
    // Staged rows’ current groups reflect user moves and beat create intent; unstaged early mirrors still need the record to repair host placement.
    const preferredClientGroupId =
      existing && state.remoteBrowserPageHandlesByPageId[existing.page.id]?.staged === true
        ? (existing.unifiedTab?.groupId ?? recordedClientGroupId)
        : (recordedClientGroupId ?? existingClientGroupId)
    const clientGroupId =
      preferredClientGroupId &&
      clientGroupIds.has(preferredClientGroupId) &&
      (renderedGroupIds.size === 0 || renderedGroupIds.has(preferredClientGroupId))
        ? preferredClientGroupId
        : undefined
    const groupId = clientGroupId ?? hostGroupId
    const content = resolveMirroredBrowserPageContent(tab, existing?.page)
    const nextPage: BrowserPage = {
      id: pageId,
      workspaceId,
      worktreeId: snapshot.worktree,
      ...content,
      faviconUrl: existing?.page.faviconUrl ?? null,
      // Guest owns client-hosted loadError; host omission must not clear it.
      loadError:
        (tab.placement?.kind === 'client' ? existing?.page.loadError : tab.loadError) ?? null,
      createdAt,
      browserRuntimeEnvironmentId: environmentId,
      viewportPresetId: existing?.page.viewportPresetId ?? null
    }
    // Reuse requires workspaceId equality or removed-workspace cleanup misses the retained page list.
    const page = existing && browserPageEqual(existing.page, nextPage) ? existing.page : nextPage
    const existingPageIds = existing?.workspace.pageIds
    const workspace: BrowserWorkspace = {
      id: workspaceId,
      worktreeId: snapshot.worktree,
      label: existing?.workspace.label,
      sessionProfileId: existing?.workspace.sessionProfileId ?? null,
      activePageId: page.id,
      // Why: the tab strip skips a tab only while every field keeps its identity.
      pageIds:
        existingPageIds && sameStringArray(existingPageIds, [page.id])
          ? existingPageIds
          : [page.id],
      url: page.url,
      title: page.title,
      loading: page.loading,
      faviconUrl: page.faviconUrl,
      canGoBack: page.canGoBack,
      canGoForward: page.canGoForward,
      loadError: page.loadError,
      createdAt
    }
    return {
      workspace,
      page,
      certificateFailure: tab.certificateFailure ?? null,
      remotePageId: tab.browserPageId,
      ...(tab.placement ? { placement: tab.placement } : {}),
      unifiedTab: buildBrowserUnifiedTab(
        workspace,
        tab,
        existing?.unifiedTab ?? null,
        groupId,
        environmentId
      ),
      hostTabId: tab.id,
      ...(clientGroupId ? { clientGroupId } : {})
    }
  })
}
