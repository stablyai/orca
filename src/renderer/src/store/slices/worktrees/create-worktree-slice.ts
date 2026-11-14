import { createObserveTerminalGitHubPullRequestLink } from './session/worktree-terminal-reference'
import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { WorktreeSlice } from './worktree-slice-contract'
import { worktreeSliceInitialState } from './session/worktree-slice-initial-state'
import { createFetchDetectedWorktrees } from './listing/fetch-detected-worktrees'
import { createFetchWorktrees } from './listing/fetch-worktrees'
import { createFetchAllWorktrees } from './listing/fetch-all-worktrees'
import {
  createAssignCrossStoreWorktreeParent,
  createAssignWorktreeParent,
  createFetchWorktreeLineage,
  createUpdateWorktreeLineage
} from './metadata/worktree-lineage-actions'
import { createUpdateWorktreeGitIdentity } from './metadata/worktree-git-identity-update'
import {
  createUpdateWorktreeBaseStatus,
  createUpdateWorktreeRemoteBranchConflict
} from './metadata/worktree-base-status'
import { createPrefetchWorktreeCreateBase } from './create/prefetch-worktree-create-base'
import { createCreateWorktree } from './create/create-worktree'
import {
  createBeginPendingWorktreeCreation,
  createRemovePendingWorktreeCreation,
  createSetActivePendingWorktreeCreation,
  createUpdatePendingWorktreeCreation
} from './create/pending-worktree-creation'
import { createRemoveWorktree } from './teardown/remove-worktree'
import {
  createClearWorktreeDeleteState,
  createMarkWorktreesDeleting,
  createMarkWorktreesQueuedForDeletion
} from './teardown/worktree-delete-state'
import { createForceDeletePreservedBranch } from './teardown/force-delete-preserved-branch'
import { createUpdateWorktreeMeta } from './metadata/update-worktree-meta'
import { createEnsureHostedReviewPushTarget } from './metadata/hosted-review-push-target-ensure'
import { createUpdateWorktreesMeta } from './metadata/update-worktrees-meta'
import {
  guardUpdateWorktreeMetaHostStatus,
  guardUpdateWorktreesMetaHostStatus
} from './metadata/foreign-host-status-guard'
import { createSetWorktreesPinnedAndReveal } from './session/worktree-pin-reveal'
import { createBumpWorktreeActivity } from './session/worktree-activity-bump'
import {
  createMarkWorktreeVisited,
  createPruneLastVisitedTimestamps,
  createSeedActiveWorktreeLastVisitedIfMissing
} from './session/worktree-visit-recency'
import { createSetActiveWorktree } from './session/set-active-worktree'
import { createSetActiveFolderWorkspace } from './session/set-active-folder-workspace'
import {
  createAllWorktrees,
  createGetKnownWorktreeById,
  createPurgeWorktreeTerminalState,
  createRemountTerminalTabForRecovery,
  createSettleTerminalTabRecovery,
  createSetRenamingWorktreeId
} from './session/worktree-slice-lookups'
import { createPurgeStaleRuntimeHostState } from './teardown/purge-stale-runtime-host-state'
import { createMigrateWorktreeIdentity } from './session/migrate-worktree-identity'

export const createWorktreeSlice: StateCreator<AppState, [], [], WorktreeSlice> = (set, get) => ({
  ...worktreeSliceInitialState,
  fetchDetectedWorktrees: createFetchDetectedWorktrees(set, get),
  fetchWorktrees: createFetchWorktrees(set, get),
  fetchAllWorktrees: createFetchAllWorktrees(set, get),
  fetchWorktreeLineage: createFetchWorktreeLineage(set, get),
  updateWorktreeLineage: createUpdateWorktreeLineage(set, get),
  assignWorktreeParent: createAssignWorktreeParent(set, get),
  assignCrossStoreWorktreeParent: createAssignCrossStoreWorktreeParent(set, get),
  updateWorktreeGitIdentity: createUpdateWorktreeGitIdentity(set, get),
  updateWorktreeBaseStatus: createUpdateWorktreeBaseStatus(set, get),
  updateWorktreeRemoteBranchConflict: createUpdateWorktreeRemoteBranchConflict(set, get),
  prefetchWorktreeCreateBase: createPrefetchWorktreeCreateBase(set, get),
  createWorktree: createCreateWorktree(set, get),
  beginPendingWorktreeCreation: createBeginPendingWorktreeCreation(set, get),
  updatePendingWorktreeCreation: createUpdatePendingWorktreeCreation(set, get),
  removePendingWorktreeCreation: createRemovePendingWorktreeCreation(set, get),
  setActivePendingWorktreeCreation: createSetActivePendingWorktreeCreation(set, get),
  removeWorktree: createRemoveWorktree(set, get),
  markWorktreesDeleting: createMarkWorktreesDeleting(set, get),
  markWorktreesQueuedForDeletion: createMarkWorktreesQueuedForDeletion(set, get),
  forceDeletePreservedBranch: createForceDeletePreservedBranch(set, get),
  clearWorktreeDeleteState: createClearWorktreeDeleteState(set, get),
  updateWorktreeMeta: guardUpdateWorktreeMetaHostStatus(createUpdateWorktreeMeta(set, get), get),
  ensureHostedReviewPushTarget: createEnsureHostedReviewPushTarget(set, get),
  updateWorktreesMeta: guardUpdateWorktreesMetaHostStatus(createUpdateWorktreesMeta(set, get), get),
  setWorktreesPinnedAndReveal: createSetWorktreesPinnedAndReveal(set, get),
  observeTerminalGitHubPullRequestLink: createObserveTerminalGitHubPullRequestLink(get),
  bumpWorktreeActivity: createBumpWorktreeActivity(set, get),
  markWorktreeVisited: createMarkWorktreeVisited(set, get),
  pruneLastVisitedTimestamps: createPruneLastVisitedTimestamps(set, get),
  seedActiveWorktreeLastVisitedIfMissing: createSeedActiveWorktreeLastVisitedIfMissing(set, get),
  setRenamingWorktreeId: createSetRenamingWorktreeId(set, get),
  remountTerminalTabForRecovery: createRemountTerminalTabForRecovery(set, get),
  settleTerminalTabRecovery: createSettleTerminalTabRecovery(set, get),
  setActiveWorktree: createSetActiveWorktree(set, get),
  setActiveFolderWorkspace: createSetActiveFolderWorkspace(set, get),
  allWorktrees: createAllWorktrees(set, get),
  getKnownWorktreeById: createGetKnownWorktreeById(set, get),
  purgeWorktreeTerminalState: createPurgeWorktreeTerminalState(set, get),
  purgeStaleRuntimeHostState: createPurgeStaleRuntimeHostState(set, get),
  migrateWorktreeIdentity: createMigrateWorktreeIdentity(set, get)
})
