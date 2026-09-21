import type { AppState } from '../store/types'

export type BrowserWorkspaceOwner = {
  worktreeId: string
  workspaceId: string
}

export function resolveBrowserWorkspaceOwner(
  state: Pick<AppState, 'browserTabsByWorktree' | 'browserPagesByWorkspace'>,
  sourceId: string,
  requiredWorktreeId?: string
): BrowserWorkspaceOwner | null {
  for (const [worktreeId, workspaces] of Object.entries(state.browserTabsByWorktree)) {
    if (requiredWorktreeId && worktreeId !== requiredWorktreeId) {
      continue
    }
    for (const workspace of workspaces) {
      if (
        workspace.id === sourceId ||
        (state.browserPagesByWorkspace[workspace.id] ?? []).some((page) => page.id === sourceId)
      ) {
        return { worktreeId, workspaceId: workspace.id }
      }
    }
  }
  return null
}
