import { resolveOwner } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import type { AppState } from '../../store/types'

/**
 * Whether a paired server owns (or may own) `worktreeId`. This desktop's runtime must not create or close browser
 * tabs there: that server's own page registry and snapshot are authoritative for them.
 */
export function isBrowserWorkspaceOwnedByPairedServer(
  state: WorktreeOperationRouteState,
  worktreeId: string
): boolean {
  const owner = resolveOwner(state, { workspaceId: worktreeId })
  // Why ambiguous refuses: rows on several hosts cannot prove this desktop owns the tab.
  return (
    owner.kind === 'ambiguous' ||
    (owner.kind === 'resolved' && owner.owner.endpoint.kind === 'environment')
  )
}

/**
 * Whether `environmentId`'s own machine is the single owner of `worktreeId`. Gates the browser
 * commands a managed SSH host forwards, so a host reaches only its own workspaces' tabs.
 */
function isBrowserWorkspaceOwnedByEnvironment(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  environmentId: string
): boolean {
  const owner = resolveOwner(state, { workspaceId: worktreeId })
  return (
    owner.kind === 'resolved' &&
    owner.owner.endpoint.kind === 'environment' &&
    owner.owner.endpoint.environmentId === environmentId &&
    owner.owner.at === 'local'
  )
}

/**
 * The workspace a managed SSH host's forwarded command may use: the named page's workspace (it may
 * not have mounted yet, so main cannot know it), or the named workspace, owned by that host.
 */
export function resolveRemoteCliBrowserWorkspace(
  state: WorktreeOperationRouteState &
    Pick<AppState, 'browserTabsByWorktree' | 'browserPagesByWorkspace'>,
  query: { environmentId: string; workspaceId?: string; pageId?: string }
): string | null {
  const pageWorkspaceId = query.pageId ? findBrowserTabWorktreeId(state, query.pageId) : null
  if (query.pageId && !pageWorkspaceId) {
    return null
  }
  if (query.workspaceId && pageWorkspaceId && query.workspaceId !== pageWorkspaceId) {
    return null
  }
  const workspaceId = pageWorkspaceId ?? query.workspaceId ?? null
  return workspaceId &&
    isBrowserWorkspaceOwnedByEnvironment(state, workspaceId, query.environmentId)
    ? workspaceId
    : null
}

/**
 * Whether this desktop renders the tab: every page records an explicit null runtime, as the tab
 * bar's + and a managed SSH host's bridged create do. A paired server's streamed page never does.
 */
export function isDesktopRenderedBrowserTab(
  state: Pick<AppState, 'browserTabsByWorktree' | 'browserPagesByWorkspace'>,
  tabOrPageId: string
): boolean {
  for (const tabs of Object.values(state.browserTabsByWorktree)) {
    for (const tab of tabs) {
      const pages = state.browserPagesByWorkspace[tab.id] ?? []
      if (tab.id === tabOrPageId || pages.some((page) => page.id === tabOrPageId)) {
        return pages.length > 0 && pages.every((page) => page.browserRuntimeEnvironmentId === null)
      }
    }
  }
  return false
}

/** The workspace holding a browser tab, addressed by its tab (workspace) id or one of its page ids. */
export function findBrowserTabWorktreeId(
  state: Pick<AppState, 'browserTabsByWorktree' | 'browserPagesByWorkspace'>,
  tabOrPageId: string
): string | null {
  for (const [worktreeId, tabs] of Object.entries(state.browserTabsByWorktree)) {
    for (const tab of tabs) {
      if (
        tab.id === tabOrPageId ||
        (state.browserPagesByWorkspace[tab.id] ?? []).some((page) => page.id === tabOrPageId)
      ) {
        return worktreeId
      }
    }
  }
  return null
}
