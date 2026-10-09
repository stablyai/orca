import type { WorktreeSlice } from '../../worktree-helpers'

export const worktreeSliceInitialState: Pick<
  WorktreeSlice,
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'worktreeCatalogVersionByRepoHost'
  | 'worktreeLineageById'
  | 'workspaceLineageByChildKey'
  | 'activeWorktreeId'
  | 'activeWorkspaceKey'
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorkspaceOwner'
  | 'pendingWorktreeCreations'
  | 'activePendingCreationId'
  | 'renamingWorktreeId'
  | 'deleteStateByWorktreeId'
  | 'baseStatusByWorktreeId'
  | 'remoteBranchConflictByWorktreeId'
  | 'sortEpoch'
  | 'settledSortEpoch'
  | 'everActivatedWorktreeIds'
  | 'lastVisitedAtByWorktreeId'
  | 'hasHydratedWorktreePurge'
  | 'startupWorktreeRefreshCompleted'
> = {
  worktreesByRepo: {},
  detectedWorktreesByRepo: {},
  worktreeCatalogVersionByRepoHost: {},
  worktreeLineageById: {},
  workspaceLineageByChildKey: {},
  activeWorktreeId: null,
  activeWorkspaceKey: null,
  activeWorkspaceExecutionHostId: null,
  activeWorkspaceOwner: null,
  pendingWorktreeCreations: {},
  activePendingCreationId: null,
  renamingWorktreeId: null,
  deleteStateByWorktreeId: {},
  baseStatusByWorktreeId: {},
  remoteBranchConflictByWorktreeId: {},
  sortEpoch: 0,
  settledSortEpoch: 0,
  everActivatedWorktreeIds: new Set<string>(),
  lastVisitedAtByWorktreeId: {},
  hasHydratedWorktreePurge: false,
  startupWorktreeRefreshCompleted: false
}
