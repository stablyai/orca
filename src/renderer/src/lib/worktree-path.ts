import type { AppState } from '@/store/types'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

// Why: only the two collections this reads, so callers holding a narrower
// slice of state (blame target resolution) can reuse it.
type AppStoreState = Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>

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
  // Why the index: this runs from a zustand selector, so an unrelated store
  // write must not flatten every worktree in every repo to answer.
  return getIndexedWorktreeById(state.worktreesByRepo, worktreeId)?.path ?? null
}
