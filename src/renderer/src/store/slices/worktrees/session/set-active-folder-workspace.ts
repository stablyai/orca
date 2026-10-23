import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { findKnownWorktreeById } from '../listing/detected-worktree-meta'
import { createSetActiveWorktree } from './set-active-worktree'

export function createSetActiveFolderWorkspace(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['setActiveFolderWorkspace'] {
  const activateWorkspace = createSetActiveWorktree(set, get)
  return (folderWorkspaceId, executionHostId) => {
    const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
    if (!findKnownWorktreeById(get(), workspaceKey, executionHostId)) {
      return
    }
    activateWorkspace(workspaceKey, executionHostId)
  }
}
