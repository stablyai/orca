import { resolveOwner } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import type { AppState } from '../../store/types'

/** Refuse desktop-runtime browser commands where a paired server owns or may own the workspace; its page registry is authoritative. */
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

/** Forward managed-host commands only to workspaces provably owned by that environment. */
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

/** Resolve the named page’s workspace or explicit workspace under the forwarding host’s ownership; pages may precede workspace mounting. */
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

/** Desktop-rendered pages record explicit null runtime, including bridged managed-SSH pages; streamed paired-server pages do not. */
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
