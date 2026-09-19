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

/**
 * The host publishes `title || url || 'Browser'` (see the runtime's browser tab projection), so a
 * page that has not produced a real title yet arrives as its own url — or as the bare default.
 * Neither says anything the local row does not already say better, so while the page still sits at
 * the url this client gave it, the local title stands and only a real navigation replaces it.
 *
 * Scope: the pre-adoption/staged window, every placement the host actually drives, and the mirror
 * of a page some other client hosts. Rows whose guest is ours never reach here — see
 * resolveMirroredBrowserPageContent.
 */
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

/**
 * Whether the guest running this page is one of ours. `placement.kind === 'client'` says only that
 * *some* client hosts it: a second desktop, or the web client that installs no page renderer at
 * all, mirrors the same row with nothing of its own to see it with. The placement names the lease
 * holder, so the comparison is exact, and it holds from the moment the host mints the placement —
 * before our guest has attached — which is the window the title would otherwise flicker through.
 */
export function clientHostsMirroredBrowserPage(tab: RuntimeMobileSessionBrowserTab): boolean {
  if (tab.placement?.kind !== 'client') {
    return false
  }
  const hostClientId = readBrowserClientHostId()
  return hostClientId !== null && tab.placement.browserHostClientId === hostClientId
}

/**
 * A page hosted by this client lives in our own guest webview; the host only ever learns its
 * content second-hand through a fire-and-forget metadata publish, so its snapshot is a stale echo
 * at best and the registry's `'Browser'`/create-time defaults at worst. Once a local row exists it
 * is the truth.
 *
 * The url is part of the payload and not just a symptom: rewinding it to the host's create-time
 * value is what breaks the staged-title hold's url-equality arm on the following snapshot.
 *
 * Every other row keeps taking the host values — a client that hosts no guest has no second
 * opinion to offer, and freezing its mirror would strand it on whatever its first snapshot said.
 */
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
    // Why: a staged row was placed by this client, so wherever it sits now is the user's own
    // choice — including a split made after the create recorded its intent. Rows the client never
    // staged carry no such truth: a pre-response snapshot may have parked them in the host group,
    // and there the record is what repairs them.
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
      // Why: a client-hosted page's load failure is observed by the local guest webview and the
      // host publishes no loadError for it, so the host snapshot must not clear the local record.
      loadError:
        (tab.placement?.kind === 'client' ? existing?.page.loadError : tab.loadError) ?? null,
      createdAt,
      browserRuntimeEnvironmentId: environmentId,
      viewportPresetId: existing?.page.viewportPresetId ?? null
    }
    // Why: reuse hinges on browserPageEqual comparing workspaceId — the removed-workspace
    // page-list cleanup gates on page.workspaceId matching this entry's workspace.id.
    const page = existing && browserPageEqual(existing.page, nextPage) ? existing.page : nextPage
    const workspace: BrowserWorkspace = {
      id: workspaceId,
      worktreeId: snapshot.worktree,
      label: existing?.workspace.label,
      sessionProfileId: existing?.workspace.sessionProfileId ?? null,
      activePageId: page.id,
      pageIds: [page.id],
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
