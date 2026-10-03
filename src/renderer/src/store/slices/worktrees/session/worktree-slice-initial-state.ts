import type { WorktreeSlice } from '../../worktree-helpers'

export const worktreeSliceInitialState: Pick<
  WorktreeSlice,
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'worktreeCatalogVersionByRepoHost'
  | 'worktreeLineageById'
  | 'workspaceLineageByChildKey'
  | 'delegatedWorktreeEdges'
  | 'activeWorktreeId'
  | 'activeWorkspaceKey'
  | 'activeWorkspaceExecutionHostId'
  | 'pendingWorktreeCreations'
  | 'activePendingCreationId'
  | 'renamingWorktreeId'
  | 'deleteStateByWorktreeId'
  | 'baseStatusByWorktreeId'
  | 'remoteBranchConflictByWorktreeId'
  | 'sortEpoch'
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
  delegatedWorktreeEdges: [],
  activeWorktreeId: null,
  activeWorkspaceKey: null,
  activeWorkspaceExecutionHostId: null,
  pendingWorktreeCreations: {},
  activePendingCreationId: null,
  renamingWorktreeId: null,
  deleteStateByWorktreeId: {},
  baseStatusByWorktreeId: {},
  remoteBranchConflictByWorktreeId: {},
  sortEpoch: 0,
  everActivatedWorktreeIds: new Set<string>(),
  lastVisitedAtByWorktreeId: {},
  hasHydratedWorktreePurge: false,
  startupWorktreeRefreshCompleted: false
}
