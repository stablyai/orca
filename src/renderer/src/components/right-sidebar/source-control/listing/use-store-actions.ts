import { useMemo } from 'react'
import { useAppStore } from '@/store'

/** Read fixed-identity actions via getState; subscribe only to generation maps, keeping the return object stable between map changes. */
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
