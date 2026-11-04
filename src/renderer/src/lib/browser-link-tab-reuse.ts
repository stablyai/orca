import type { AppState } from '@/store/types'
import { createBrowserLinkHostMatcher } from './browser-link-owner'
import {
  browserLinkUrlIdentity,
  createBrowserLinkPageMatcher,
  type BrowserLinkDestination,
  type BrowserOpenResult
} from './browser-link-destination'
import { findVisibleBrowserLinkTarget } from './visible-browser-link-target'
import { liveLinkOpenGroupIds, type LinkOpenIntent } from './link-open-intent'

/** Opt-in reuse navigates client-rendered website pages only; explicit group requests keep their own placement. */
function canReuseBrowserLinkTab(
  state: AppState,
  destination: BrowserLinkDestination,
  intent: LinkOpenIntent | null
): boolean {
  return (
    state.settings?.openLinksInExistingBrowserTab === true &&
    !intent?.targetGroupId &&
    destination.browserRuntimeEnvironmentId === null &&
    destination.resource.kind === 'website' &&
    browserLinkUrlIdentity(destination.resource.url) !== null
  )
}

/** The browser tab a link navigates in place: the focused group's visible one, else the most recently focused. */
export function findReusableBrowserLinkTab(
  state: AppState,
  destination: BrowserLinkDestination,
  intent: LinkOpenIntent | null
): BrowserOpenResult | null {
  if (!canReuseBrowserLinkTab(state, destination, intent)) {
    return null
  }
  const { worktreeId, executionHostId } = destination
  const matchesHost = createBrowserLinkHostMatcher(state, worktreeId, executionHostId)
  const matchesPage = createBrowserLinkPageMatcher(state, destination, { anyWebsite: true })
  const liveGroups = liveLinkOpenGroupIds(state, worktreeId)
  const workspaces = new Map(
    (state.browserTabsByWorktree[worktreeId] ?? []).map((workspace) => [workspace.id, workspace])
  )
  const candidates = new Map<string, BrowserOpenResult>()
  const focusedAt = new Map<string, number>()
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    const workspace = tab.contentType === 'browser' ? workspaces.get(tab.entityId) : undefined
    const page = workspace
      ? (state.browserPagesByWorkspace[workspace.id] ?? []).find(
          (item) => item.id === workspace.activePageId
        )
      : undefined
    if (
      !workspace ||
      !page ||
      !matchesHost(tab.executionHostId) ||
      !liveGroups.has(tab.groupId) ||
      !matchesPage(workspace, page)
    ) {
      continue
    }
    candidates.set(tab.id, {
      worktreeId,
      executionHostId,
      browserWorkspaceId: workspace.id,
      browserPageId: page.id,
      unifiedTabId: tab.id,
      groupId: tab.groupId
    })
    focusedAt.set(tab.id, tab.lastFocusedAt ?? 0)
  }
  const visibleGroupId = findVisibleBrowserLinkTarget(state, worktreeId, (tab) =>
    candidates.has(tab.id)
  )?.targetGroupId
  // Only the focused group's tab skips the recency check; other visible tabs compete with hidden ones.
  const focusedGroupId =
    visibleGroupId === state.activeGroupIdByWorktree[worktreeId] ? visibleGroupId : undefined
  const visibleTabId = (state.groupsByWorktree[worktreeId] ?? []).find(
    (group) => group.id === focusedGroupId
  )?.activeTabId
  let best = visibleTabId ? candidates.get(visibleTabId) : undefined
  if (!best) {
    for (const candidate of candidates.values()) {
      if (
        !best ||
        (focusedAt.get(candidate.unifiedTabId) ?? 0) > (focusedAt.get(best.unifiedTabId) ?? 0)
      ) {
        best = candidate
      }
    }
  }
  return best ?? null
}
