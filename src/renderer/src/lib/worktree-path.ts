import { useAppStore } from '@/store'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

type AppStoreState = ReturnType<typeof useAppStore.getState>

// Resolve a worktree/folder-workspace id to its absolute root path from store
// state, so callers don't reconstruct it by slicing a file's absolute path
// (which breaks for root worktrees like "/" or "C:\").
export function worktreePathFromState(
  state: AppStoreState,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return (
      state.folderWorkspaces.find(
        (workspace) => workspace.id === parsedWorkspaceKey.folderWorkspaceId
      )?.folderPath ?? null
    )
  }
  const worktrees = Object.values(state.worktreesByRepo ?? {}).flat()
  return worktrees.find((worktree) => worktree.id === worktreeId)?.path ?? null
}

export function getWorktreePathById(worktreeId: string | null): string | null {
  return worktreePathFromState(useAppStore.getState(), worktreeId)
}
