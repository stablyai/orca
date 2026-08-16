import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
export function createUpdateWorktreeBaseStatus(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeBaseStatus'] {
  return (event) => {
    set((s) => ({
      baseStatusByWorktreeId: {
        ...s.baseStatusByWorktreeId,
        [event.worktreeId]: event
      }
    }))
  }
}

export function createUpdateWorktreeRemoteBranchConflict(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeRemoteBranchConflict'] {
  return (event) => {
    set((s) => ({
      remoteBranchConflictByWorktreeId: {
        ...s.remoteBranchConflictByWorktreeId,
        [event.worktreeId]: event
      }
    }))
  }
}
