import { useAppStore } from '@/store'

/**
 * Binds every store action the Source Control panel dispatches. Each entry keeps its own selector so
 * the returned references stay stable and can be used directly in downstream dependency arrays.
 */
export function useSourceControlStoreActions() {
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const getHostedReviewCreationEligibility = useAppStore(
    (s) => s.getHostedReviewCreationEligibility
  )
  const createHostedReview = useAppStore((s) => s.createHostedReview)
  const createStackedHostedReview = useAppStore((s) => s.createStackedHostedReview)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const enqueueGitHubPRRefresh = useAppStore((s) => s.enqueueGitHubPRRefresh)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const setGitStatus = useAppStore((s) => s.setGitStatus)
  const updateWorktreeGitIdentity = useAppStore((s) => s.updateWorktreeGitIdentity)
  const beginGitBranchCompareRequest = useAppStore((s) => s.beginGitBranchCompareRequest)
  const setGitBranchCompareResult = useAppStore((s) => s.setGitBranchCompareResult)
  const fetchUpstreamStatus = useAppStore((s) => s.fetchUpstreamStatus)
  const ensureHostedReviewPushTarget = useAppStore((s) => s.ensureHostedReviewPushTarget)
  const setUpstreamStatus = useAppStore((s) => s.setUpstreamStatus)
  const pushBranch = useAppStore((s) => s.pushBranch)
  const pullBranch = useAppStore((s) => s.pullBranch)
  const fastForwardBranch = useAppStore((s) => s.fastForwardBranch)
  const syncBranch = useAppStore((s) => s.syncBranch)
  const rebaseFromBase = useAppStore((s) => s.rebaseFromBase)
  const fetchBranch = useAppStore((s) => s.fetchBranch)
  const revealInExplorer = useAppStore((s) => s.revealInExplorer)
  const openConflictReview = useAppStore((s) => s.openConflictReview)
  const openAllDiffs = useAppStore((s) => s.openAllDiffs)
  const openBranchAllDiffs = useAppStore((s) => s.openBranchAllDiffs)
  const deleteDiffComment = useAppStore((s) => s.deleteDiffComment)
  const clearDiffComments = useAppStore((s) => s.clearDiffComments)
  const clearDiffCommentsForFile = useAppStore((s) => s.clearDiffCommentsForFile)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const prGenerationRecords = useAppStore((s) => s.pullRequestGenerationRecords)
  const allocatePullRequestGenerationRequestId = useAppStore(
    (s) => s.allocatePullRequestGenerationRequestId
  )
  const setPullRequestGenerationRecord = useAppStore((s) => s.setPullRequestGenerationRecord)
  const updatePullRequestGenerationRecord = useAppStore((s) => s.updatePullRequestGenerationRecord)
  const commitMessageGenerationRecords = useAppStore((s) => s.commitMessageGenerationRecords)
  const allocateCommitMessageGenerationRequestId = useAppStore(
    (s) => s.allocateCommitMessageGenerationRequestId
  )
  const setCommitMessageGenerationRecord = useAppStore((s) => s.setCommitMessageGenerationRecord)
  const updateCommitMessageGenerationRecord = useAppStore(
    (s) => s.updateCommitMessageGenerationRecord
  )

  return {
    allocateCommitMessageGenerationRequestId,
    allocatePullRequestGenerationRequestId,
    beginGitBranchCompareRequest,
    clearDiffComments,
    clearDiffCommentsForFile,
    commitMessageGenerationRecords,
    createHostedReview,
    createStackedHostedReview,
    deleteDiffComment,
    enqueueGitHubPRRefresh,
    ensureHostedReviewPushTarget,
    fastForwardBranch,
    fetchBranch,
    fetchHostedReviewForBranch,
    fetchPRForBranch,
    fetchUpstreamStatus,
    getHostedReviewCreationEligibility,
    openAllDiffs,
    openBranchAllDiffs,
    openConflictReview,
    openSettingsPage,
    openSettingsTarget,
    prGenerationRecords,
    pullBranch,
    pushBranch,
    rebaseFromBase,
    revealInExplorer,
    setCommitMessageGenerationRecord,
    setGitBranchCompareResult,
    setGitStatus,
    setPullRequestGenerationRecord,
    setRightSidebarOpen,
    setRightSidebarTab,
    setUpstreamStatus,
    syncBranch,
    updateCommitMessageGenerationRecord,
    updatePullRequestGenerationRecord,
    updateRepo,
    updateSettings,
    updateWorktreeGitIdentity,
    updateWorktreeMeta
  }
}

export type SourceControlStoreActions = ReturnType<typeof useSourceControlStoreActions>
