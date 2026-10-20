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
  | 'pendingWorktreeCreations'
  | 'activePendingCreationId'
  | 'renamingWorktreeId'
  | 'deleteStateByWorktreeId'
  | 'baseStatusByWorktreeId'
  | 'remoteBranchConflictByWorktreeId'
  | 'everActivatedWorktreeIds'
  | 'lastVisitedAtByWorktreeId'
  | 'hasHydratedWorktreePurge'
  | 'startupWorktreeRefreshCompleted'
  | 'startupLocalCatalogHydrated'
> = {
  worktreesByRepo: {},
  detectedWorktreesByRepo: {},
  worktreeCatalogVersionByRepoHost: {},
  worktreeLineageById: {},
  workspaceLineageByChildKey: {},
  activeWorktreeId: null,
  activeWorkspaceKey: null,
  activeWorkspaceExecutionHostId: null,
  pendingWorktreeCreations: {},
  activePendingCreationId: null,
  renamingWorktreeId: null,
  deleteStateByWorktreeId: {},
  baseStatusByWorktreeId: {},
  remoteBranchConflictByWorktreeId: {},
  everActivatedWorktreeIds: new Set<string>(),
  lastVisitedAtByWorktreeId: {},
  hasHydratedWorktreePurge: false,
  startupWorktreeRefreshCompleted: false,
  startupLocalCatalogHydrated: false
}
