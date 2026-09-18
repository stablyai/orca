import { getConnectionIdFromState } from '@/lib/connection-context'
import { isLocalPathOpenBlockedForRuntimeOwner } from '@/lib/local-path-open-guard'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'

export function isFileExplorerRevealBlocked(
  state: Parameters<typeof getExplicitRuntimeEnvironmentIdForWorktree>[0],
  worktreeId: string | null | undefined
): boolean {
  const connectionId = getConnectionIdFromState(
    {
      folderWorkspaces: state.folderWorkspaces ?? [],
      projectGroups: state.projectGroups ?? [],
      repos: state.repos ?? [],
      worktreesByRepo: state.worktreesByRepo ?? {}
    },
    worktreeId ?? null
  )
  // Why: an unresolved SSH worktree must not fall through to local openPath.
  if (connectionId === undefined) {
    return true
  }
  return isLocalPathOpenBlockedForRuntimeOwner(
    state.settings,
    getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId),
    { connectionId }
  )
}
