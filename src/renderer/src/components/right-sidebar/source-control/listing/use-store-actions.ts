import { useMemo } from 'react'
import { useAppStore } from '@/store'

/**
 * Binds every store action the Source Control panel dispatches.
 *
 * Why `getState()` and not one selector each: zustand action identities are fixed when the store is
 * built and no slice ever puts one in a `set()` payload, so subscribing to them can never fire. The
 * 40 action subscriptions only added 40 live listeners and 40 selector runs to every store write
 * while the panel was mounted. The two generation-record maps are real state, so they stay
 * subscribed.
 *
 * Reference stability is preserved and slightly stronger than before: each action keeps the single
 * identity it was created with, and the returned object itself is now stable until one of the two
 * subscribed maps changes, so downstream dependency arrays keep working.
 */
export function useSourceControlStoreActions() {
  const prGenerationRecords = useAppStore((s) => s.pullRequestGenerationRecords)
  const commitMessageGenerationRecords = useAppStore((s) => s.commitMessageGenerationRecords)

  return useMemo(() => {
    const state = useAppStore.getState()
    return {
      allocateCommitMessageGenerationRequestId: state.allocateCommitMessageGenerationRequestId,
      allocatePullRequestGenerationRequestId: state.allocatePullRequestGenerationRequestId,
      beginGitBranchCompareRequest: state.beginGitBranchCompareRequest,
      clearDiffComments: state.clearDiffComments,
      clearDiffCommentsForFile: state.clearDiffCommentsForFile,
      commitMessageGenerationRecords,
      createHostedReview: state.createHostedReview,
      createStackedHostedReview: state.createStackedHostedReview,
      deleteDiffComment: state.deleteDiffComment,
      enqueueGitHubPRRefresh: state.enqueueGitHubPRRefresh,
      ensureHostedReviewPushTarget: state.ensureHostedReviewPushTarget,
      fastForwardBranch: state.fastForwardBranch,
      fetchBranch: state.fetchBranch,
      fetchHostedReviewForBranch: state.fetchHostedReviewForBranch,
      fetchPRForBranch: state.fetchPRForBranch,
      fetchUpstreamStatus: state.fetchUpstreamStatus,
      getHostedReviewCreationEligibility: state.getHostedReviewCreationEligibility,
      openAllDiffs: state.openAllDiffs,
      openBranchAllDiffs: state.openBranchAllDiffs,
      openConflictReview: state.openConflictReview,
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
      updateRepo: state.updateRepo,
      updateSettings: state.updateSettings,
      updateWorktreeGitIdentity: state.updateWorktreeGitIdentity,
      updateWorktreeMeta: state.updateWorktreeMeta
    }
  }, [commitMessageGenerationRecords, prGenerationRecords])
}

export type SourceControlStoreActions = ReturnType<typeof useSourceControlStoreActions>
