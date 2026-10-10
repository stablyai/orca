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
