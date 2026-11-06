import type { AppState } from '@/store/types'
import { useSourceControlScope } from '../panel/worktree-scope'
import { useMemo } from 'react'
import { useAppStore } from '@/store'

/** Read fixed-identity actions via getState; subscribe only to generation maps, keeping the return object stable between map changes. */
export function useSourceControlStoreActions() {
  const scope = useSourceControlScope()
  const prGenerationRecords = useAppStore((s) => s.pullRequestGenerationRecords)
  const commitMessageGenerationRecords = useAppStore((s) => s.commitMessageGenerationRecords)

  return useMemo(() => {
    const options = {
      placementWorkspaceId: scope?.placementWorkspaceId,
      executionHostId: scope?.executionHostId,
      runtimeEnvironmentId: scope
        ? (scope.worktree.runtimeOwnerEnvironmentId ??
          (scope.executionHostId.startsWith('runtime:')
            ? decodeURIComponent(scope.executionHostId.slice(8))
            : null))
        : undefined
    }
    const state = useAppStore.getState()
    return {
      allocateCommitMessageGenerationRequestId: state.allocateCommitMessageGenerationRequestId,
      allocatePullRequestGenerationRequestId: state.allocatePullRequestGenerationRequestId,
      beginGitBranchCompareRequest: state.beginGitBranchCompareRequest,
      clearDiffComments: state.clearDiffComments,
      clearDiffCommentsForFile: state.clearDiffCommentsForFile,
      commitMessageGenerationRecords,
      createHostedReview: (path, input) =>
        state.createHostedReview(path, {
          ...input,
          ...(scope ? { repoOwnerExecutionHostId: scope.executionHostId } : {})
        }),
      createStackedHostedReview: (path, input) =>
        state.createStackedHostedReview(path, {
          ...input,
          ...(scope ? { repoOwnerExecutionHostId: scope.executionHostId } : {})
        }),
      deleteDiffComment: state.deleteDiffComment,
      enqueueGitHubPRRefresh: state.enqueueGitHubPRRefresh,
      ensureHostedReviewPushTarget: state.ensureHostedReviewPushTarget,
      fastForwardBranch: state.fastForwardBranch,
      fetchBranch: state.fetchBranch,
      fetchHostedReviewForBranch: (path, branch, options) =>
        state.fetchHostedReviewForBranch(path, branch, {
          ...options,
          ...(scope ? { repoOwnerExecutionHostId: scope.executionHostId } : {})
        }),
      fetchPRForBranch: (path, branch, options) =>
        state.fetchPRForBranch(path, branch, {
          ...options,
          ...(scope ? { repoOwnerExecutionHostId: scope.executionHostId } : {})
        }),
      fetchUpstreamStatus: state.fetchUpstreamStatus,
      getHostedReviewCreationEligibility: (args) =>
        state.getHostedReviewCreationEligibility({
          ...args,
          ...(scope ? { repoOwnerExecutionHostId: scope.executionHostId } : {})
        }),
      openAllDiffs: (id, path, alternate, filter, entries) =>
        state.openAllDiffs(id, path, alternate, filter, entries, options),
      openBranchAllDiffs: (id, path, compare, alternate) =>
        state.openBranchAllDiffs(id, path, compare, alternate, options),
      openConflictReview: (id, path, entries, source) =>
        state.openConflictReview(id, path, entries, source, options),
      openModal: state.openModal,
      openSettingsPage: state.openSettingsPage,
      openSettingsTarget: state.openSettingsTarget,
      prGenerationRecords,
      pullBranch: state.pullBranch,
      pushBranch: state.pushBranch,
      rebaseFromBase: state.rebaseFromBase,
      revealInExplorer: state.revealInExplorer,
      setCommitMessageGenerationRecord: state.setCommitMessageGenerationRecord,
      setGitBranchCompareResult: state.setGitBranchCompareResult,
      setGitStatus: state.setGitStatus,
      setPullRequestGenerationRecord: state.setPullRequestGenerationRecord,
      setRightSidebarOpen: state.setRightSidebarOpen,
      setRightSidebarTab: state.setRightSidebarTab,
      setUpstreamStatus: state.setUpstreamStatus,
      syncBranch: state.syncBranch,
      updateCommitMessageGenerationRecord: state.updateCommitMessageGenerationRecord,
      updatePullRequestGenerationRecord: state.updatePullRequestGenerationRecord,
      updateRepo: (id, updates, options) =>
        state.updateRepo(id, updates, {
          ...options,
          ...(scope ? { hostId: scope.executionHostId } : {})
        }),
      updateSettings: state.updateSettings,
      updateWorktreeGitIdentity: state.updateWorktreeGitIdentity,
      updateWorktreeMeta: (id, updates, options) =>
        state.updateWorktreeMeta(id, updates, {
          ...options,
          ...(scope ? { executionHostId: scope.executionHostId } : {})
        })
    } satisfies Partial<AppState>
  }, [commitMessageGenerationRecords, prGenerationRecords, scope])
}

export type SourceControlStoreActions = ReturnType<typeof useSourceControlStoreActions>
