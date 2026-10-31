import type { ExecutionHostId } from '../../../shared/execution-host'
import type { AppState } from '@/store/types'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo,
  type WorkspaceRecordState
} from '@/store/workspace-record-selectors'

// Skill discovery omits detected rows, so detected-only workspaces have no directory there.
export type WorkspaceDirectoryState = WorkspaceRecordState &
  Pick<AppState, 'floatingWorkspacePath'> &
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
    projectGroups: state.projectGroups,
    repos: state.repos,
    worktreesByRepo: selectWorktreesByRepo(state),
    detectedWorktreesByRepo: state.detectedWorktreesByRepo ?? NO_DETECTED_WORKTREES,
    folderWorkspaces: selectFolderWorkspaces(state),
    floatingWorkspacePath: state.floatingWorkspacePath
  }
  return findKnownWorktreeById(catalog, worktreeId, executionHostId ?? undefined)?.path || null
}
