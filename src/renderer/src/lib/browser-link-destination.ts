import type { Tab } from '../../../shared/tab-types'
import { createBrowserLinkHostMatcher } from './browser-link-owner'
import { createBrowserLinkSessionMatcher } from './browser-link-session'
import type { AppState } from '@/store/types'
import type {
  BrowserPage,
  BrowserPageDocLocation,
  BrowserWorkspace
} from '../../../shared/browser-workspace-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { normalizeBrowserNavigationUrl, redactKagiSessionToken } from '../../../shared/browser-url'
import { browserPageDocLocationsEqual } from '../../../shared/browser-page-doc-location'
import { findVisibleBrowserLinkTarget } from './visible-browser-link-target'
import type { TabSplitTarget } from '@/store/slices/tabs/tabs-slice-contract'
import { isLiveLinkOpenGroup, liveLinkOpenGroupIds, type LinkOpenIntent } from './link-open-intent'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from './worktree-runtime-owner'

export type BrowserLinkDestination = {
  worktreeId: string
  executionHostId: ExecutionHostId
  browserRuntimeEnvironmentId: string | null
  profileHostId: ExecutionHostId
  sessionProfileId: string | null
  sessionPartition: string | null
  resource:
    | { kind: 'website'; url: string }
    | { kind: 'local-file'; url: string }
    | { kind: 'document'; docLocation: BrowserPageDocLocation }
}

export type BrowserOpenResult = {
  worktreeId: string
  executionHostId: ExecutionHostId
  browserWorkspaceId: string
  browserPageId: string
  unifiedTabId: string
  groupId: string
}

export type BrowserOpenOutcome =
  | { status: 'opened'; result: BrowserOpenResult }
  | { status: 'refused' | 'unsupported' | 'superseded' | 'failed' }

export type BrowserLinkOpenContext = {
  linkIntent: LinkOpenIntent | null
  isCurrentRequest?: () => boolean
  canReveal?: () => boolean
}

/** Credential-bearing requests cannot use their redacted stored URL as an identity. */
export function browserLinkUrlIdentity(url: string): string | null {
  if (!/^https?:\/\//i.test(url.trim())) {
    return null
  }
  const normalized = normalizeBrowserNavigationUrl(url)
  if (!normalized || redactKagiSessionToken(normalized) !== normalized) {
    return null
  }
  const parsed = new URL(normalized)
  return parsed.username || parsed.password ? null : normalized
}

export function createBrowserLinkPageMatcher(
  state: AppState,
  destination: BrowserLinkDestination
): (workspace: BrowserWorkspace, page: BrowserPage) => boolean {
  const matchesSession = createBrowserLinkSessionMatcher(
    state,
    destination.profileHostId,
    destination.sessionProfileId,
    destination.sessionPartition
  )
  const inferredRuntimeId =
    runtimeEnvironmentIdOrLocalUnlessTwin(state, destination.worktreeId) ?? null
  const resource = destination.resource
  const urlIdentity = resource.kind === 'website' ? browserLinkUrlIdentity(resource.url) : null
  return (workspace, page) => {
    if (page.workspaceId !== workspace.id || page.worktreeId !== destination.worktreeId) {
      return false
    }
    const handle = state.remoteBrowserPageHandlesByPageId[page.id]
    if (handle?.staged || handle?.restoredFromSession) {
      return false
    }
    const runtimeId =
      handle?.environmentId ??
      (page.browserRuntimeEnvironmentId === undefined
        ? inferredRuntimeId
        : page.browserRuntimeEnvironmentId)
    if (runtimeId !== destination.browserRuntimeEnvironmentId) {
      return false
    }
    // Mirrored workspace metadata cannot prove which login the host's page actually uses.
    if (
      runtimeId
        ? handle?.browserProfileId !== (destination.sessionProfileId ?? 'default')
        : !matchesSession(workspace)
    ) {
      return false
    }
    if (resource.kind === 'document') {
      return browserPageDocLocationsEqual(page.docLocation ?? null, resource.docLocation)
    }
    if (page.docLocation) {
      return false
    }
    return resource.kind === 'local-file'
      ? page.url === resource.url
      : urlIdentity !== null && browserLinkUrlIdentity(page.url) === urlIdentity
  }
}

export function browserLinkPageMatches(
  state: AppState,
  destination: BrowserLinkDestination,
  workspace: BrowserWorkspace,
  page: BrowserPage
): boolean {
  return createBrowserLinkPageMatcher(state, destination)(workspace, page)
}

export function browserOpenResultForPage(
  state: AppState,
  destination: Pick<BrowserLinkDestination, 'worktreeId' | 'executionHostId'>,
  workspaceId: string,
  pageId: string
): BrowserOpenResult | null {
  const matchesHost = createBrowserLinkHostMatcher(
    state,
    destination.worktreeId,
    destination.executionHostId
  )
  const wrapper = (state.unifiedTabsByWorktree[destination.worktreeId] ?? []).find(
    (tab) =>
      tab.contentType === 'browser' &&
      tab.entityId === workspaceId &&
      matchesHost(tab.executionHostId)
  )
  const workspace = (state.browserTabsByWorktree[destination.worktreeId] ?? []).find(
    (tab) => tab.id === workspaceId
  )
  const page = (state.browserPagesByWorkspace[workspaceId] ?? []).find((item) => item.id === pageId)
  if (
    !workspace ||
    !wrapper ||
    !page ||
    page.workspaceId !== workspaceId ||
    page.worktreeId !== destination.worktreeId ||
    !isLiveLinkOpenGroup(state, destination.worktreeId, wrapper.groupId)
  ) {
    return null
  }
  return {
    worktreeId: destination.worktreeId,
    executionHostId: destination.executionHostId,
    browserWorkspaceId: workspaceId,
    browserPageId: pageId,
    unifiedTabId: wrapper.id,
    groupId: wrapper.groupId
  }
}

export function currentBrowserLinkMatch(
  state: AppState,
  destination: BrowserLinkDestination,
  match: BrowserOpenResult
): BrowserOpenResult | null {
  const actual = browserOpenResultForPage(
    state,
    destination,
    match.browserWorkspaceId,
    match.browserPageId
  )
  const workspace = state.browserTabsByWorktree[destination.worktreeId]?.find(
    (item) => item.id === match.browserWorkspaceId
  )
  const page = state.browserPagesByWorkspace[match.browserWorkspaceId]?.find(
    (item) => item.id === match.browserPageId
  )
  return actual &&
    actual.groupId === match.groupId &&
    workspace &&
    page &&
    browserLinkPageMatches(state, destination, workspace, page)
    ? actual
    : null
}

export function selectBrowserLinkDestination(
  state: AppState,
  destination: BrowserLinkDestination,
  intent: LinkOpenIntent | null
):
  | { status: 'ready'; groupId?: string; split?: TabSplitTarget; match: BrowserOpenResult | null }
  | { status: 'refused' } {
  const { worktreeId, executionHostId } = destination
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const matchesHost = createBrowserLinkHostMatcher(state, worktreeId, executionHostId)
  if (
    intent?.targetGroupId &&
    (intent.workspaceId !== worktreeId ||
      !matchesHost(intent.hostId) ||
      !isLiveLinkOpenGroup(state, worktreeId, intent.targetGroupId))
  ) {
    return { status: 'refused' }
  }
  const workspaces = new Map(
    (state.browserTabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab])
  )
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const tabsById = new Map<string, Tab>()
  const wrappersByWorkspace = new Map<string, Tab | null>()
  for (const tab of tabs) {
    tabsById.set(tab.id, tab)
    if (tab.contentType === 'browser') {
      wrappersByWorkspace.set(tab.entityId, wrappersByWorkspace.has(tab.entityId) ? null : tab)
    }
  }
  const matchesByTab = new Map<string, BrowserOpenResult>()
  const matchesPage = createBrowserLinkPageMatcher(state, destination)
  const matchingGroups = new Set<string>()
  const liveGroups = liveLinkOpenGroupIds(state, worktreeId)
  for (const tab of wrappersByWorkspace.values()) {
    if (
      !tab ||
      tab.contentType !== 'browser' ||
      !matchesHost(tab.executionHostId) ||
      !liveGroups.has(tab.groupId)
    ) {
      continue
    }
    const workspace = workspaces.get(tab.entityId)
    if (!workspace) {
      continue
    }
    const matchingPages = (state.browserPagesByWorkspace[workspace.id] ?? []).filter((page) =>
      matchesPage(workspace, page)
    )
    const pagesById = new Map(matchingPages.map((page) => [page.id, page]))
    const page =
      (workspace.activePageId ? pagesById.get(workspace.activePageId) : undefined) ??
      workspace.pageIds?.map((id) => pagesById.get(id)).find((item) => item !== undefined) ??
      matchingPages.reduce<BrowserPage | undefined>(
        (best, item) => (!best || item.id < best.id ? item : best),
        undefined
      )
    if (!page) {
      continue
    }
    matchesByTab.set(tab.id, {
      worktreeId,
      executionHostId,
      browserWorkspaceId: workspace.id,
      browserPageId: page.id,
      unifiedTabId: tab.id,
      groupId: tab.groupId
    })
    matchingGroups.add(tab.groupId)
  }
  let groupId = intent?.targetGroupId
  const focusedGroupId = state.activeGroupIdByWorktree[worktreeId]
  if (!groupId && matchesByTab.size > 0) {
    groupId =
      findVisibleBrowserLinkTarget(state, worktreeId, (tab) => matchesByTab.has(tab.id))
        ?.targetGroupId ??
      (focusedGroupId && matchingGroups.has(focusedGroupId) ? focusedGroupId : undefined) ??
      [...liveGroups].find((id) => matchingGroups.has(id))
  }
  if (!groupId) {
    groupId = findVisibleBrowserLinkTarget(
      state,
      worktreeId,
      (tab) =>
        matchesHost(tab.executionHostId) && workspaces.has(tabsById.get(tab.id)?.entityId ?? '')
    )?.targetGroupId
  }
  if (!groupId) {
    const source =
      intent?.workspaceId === worktreeId && matchesHost(intent.hostId)
        ? tabsById.get(intent.sourceTabId)
        : undefined
    const sourceGroupId =
      source &&
      (source.executionHostId ?? null) === intent?.hostId &&
      liveGroups.has(source.groupId)
        ? source.groupId
        : focusedGroupId && liveGroups.has(focusedGroupId)
          ? focusedGroupId
          : [...liveGroups][0]
    if (sourceGroupId && groups.find((group) => group.id === sourceGroupId)?.activeTabId) {
      return {
        status: 'ready',
        split: { sourceGroupId, splitDirection: 'right', activate: false },
        match: null
      }
    }
    groupId = sourceGroupId
  }
  const group = groups.find((item) => item.id === groupId)
  const ids = group ? [group.activeTabId, ...group.tabOrder] : []
  for (const id of ids) {
    const match = id ? matchesByTab.get(id) : undefined
    if (match && match.groupId === groupId) {
      return { status: 'ready', groupId, match }
    }
  }
  return { status: 'ready', groupId, match: null }
}
