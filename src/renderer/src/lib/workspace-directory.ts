import type { ExecutionHostId } from '../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'

// Why optional: narrow callers (skill discovery) only carry the catalogs they subscribe to.
export type WorkspaceDirectoryState = {
  worktreesByRepo?: Record<
    string,
    readonly { id: string; path: string; hostId?: ExecutionHostId }[]
  >
  folderWorkspaces?: readonly { id: string; folderPath: string }[]
  floatingWorkspacePath?: string | null
  getKnownWorktreeById?: AppState['getKnownWorktreeById']
}

/**
 * Where a workspace lives on disk: a catalog worktree, a folder workspace, or the floating
 * workspace. `executionHostId` narrows a catalog lookup to one host's row.
 */
export function resolveWorkspaceDirectory(
  state: WorkspaceDirectoryState,
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): string | null {
  if (isFloatingWorkspaceId(worktreeId)) {
    // Why: floating has no catalog row and always runs on the local host.
    return !executionHostId || executionHostId === 'local'
      ? state.floatingWorkspacePath || null
      : null
  }
  const known = state.getKnownWorktreeById?.(worktreeId, executionHostId ?? undefined)
  if (known?.path) {
    return known.path
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return (
      state.folderWorkspaces?.find((entry) => entry.id === workspaceScope.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    const match = worktrees.find(
      (entry) => entry.id === worktreeId && (!executionHostId || entry.hostId === executionHostId)
    )
    if (match?.path) {
      return match.path
    }
  }
  return null
}
