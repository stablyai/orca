import type { ExecutionHostId } from '../../../shared/execution-host'
import type { AppState } from '@/store/types'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'

// Why detected rows are optional: skill discovery does not subscribe to them, so a detected-only
// workspace has no directory there.
export type WorkspaceDirectoryState = Pick<
  AppState,
  'worktreesByRepo' | 'folderWorkspaces' | 'floatingWorkspacePath'
> &
  Partial<Pick<AppState, 'detectedWorktreesByRepo'>>

const NO_DETECTED_WORKTREES: AppState['detectedWorktreesByRepo'] = {}

/**
 * Where a workspace lives on disk: a catalog worktree, a folder workspace, or the floating
 * workspace. `executionHostId` narrows the lookup to one host's row.
 */
export function resolveWorkspaceDirectory(
  state: WorkspaceDirectoryState,
  worktreeId: string,
  executionHostId?: ExecutionHostId | null
): string | null {
  const catalog = {
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo ?? NO_DETECTED_WORKTREES,
    folderWorkspaces: state.folderWorkspaces,
    floatingWorkspacePath: state.floatingWorkspacePath
  }
  return findKnownWorktreeById(catalog, worktreeId, executionHostId ?? undefined)?.path || null
}
