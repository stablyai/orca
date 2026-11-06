import type { AppState } from '@/store/types'
import {
  sourceControlScopeRuntimeEnvironmentId,
  useSourceControlScope
} from '../panel/worktree-scope'
import { useMemo } from 'react'
import { useAppStore } from '@/store'

/** Read fixed-identity actions via getState; key section wrappers on primitive routing so store writes never rebuild them. */
export function useSourceControlStoreActions() {
  const scope = useSourceControlScope()
  const executionHostId = scope?.executionHostId
  const placementWorkspaceId = scope?.placementWorkspaceId
  const runtimeEnvironmentId = sourceControlScopeRuntimeEnvironmentId(scope)

  return useMemo(() => {
    const options = { placementWorkspaceId, executionHostId, runtimeEnvironmentId }
    const state = useAppStore.getState()
    const createHostedReview: AppState['createHostedReview'] = (path, input) =>
      state.createHostedReview(path, {
        ...input,
        ...(executionHostId ? { repoOwnerExecutionHostId: executionHostId } : {})
      })
    const createStackedHostedReview: AppState['createStackedHostedReview'] = (path, input) =>
      state.createStackedHostedReview(path, {
        ...input,
        ...(executionHostId ? { repoOwnerExecutionHostId: executionHostId } : {})
      })
    const fetchHostedReviewForBranch: AppState['fetchHostedReviewForBranch'] = (
      path,
      branch,
      options
    ) =>
      state.fetchHostedReviewForBranch(path, branch, {
        ...options,
        ...(executionHostId ? { repoOwnerExecutionHostId: executionHostId } : {})
      })
    const fetchPRForBranch: AppState['fetchPRForBranch'] = (path, branch, options) =>
      state.fetchPRForBranch(path, branch, {
        ...options,
        ...(executionHostId ? { repoOwnerExecutionHostId: executionHostId } : {})
      })
    const getHostedReviewCreationEligibility: AppState['getHostedReviewCreationEligibility'] = (
      args
    ) =>
      state.getHostedReviewCreationEligibility({
        ...args,
        ...(executionHostId ? { repoOwnerExecutionHostId: executionHostId } : {})
      })
    const openAllDiffs: AppState['openAllDiffs'] = (id, path, alternate, filter, entries) =>
      state.openAllDiffs(id, path, alternate, filter, entries, options)
    const openBranchAllDiffs: AppState['openBranchAllDiffs'] = (id, path, compare, alternate) =>
      state.openBranchAllDiffs(id, path, compare, alternate, options)
    const openConflictReview: AppState['openConflictReview'] = (id, path, entries, source) =>
      state.openConflictReview(id, path, entries, source, options)
    const updateRepo: AppState['updateRepo'] = (id, updates, options) =>
      state.updateRepo(id, updates, {
        ...options,
        ...(executionHostId ? { hostId: executionHostId } : {})
      })
    const updateWorktreeMeta: AppState['updateWorktreeMeta'] = (id, updates, options) =>
      state.updateWorktreeMeta(id, updates, {
        ...options,
        ...(executionHostId ? { executionHostId } : {})
      })
    return {
      allocateCommitMessageGenerationRequestId: state.allocateCommitMessageGenerationRequestId,
      allocatePullRequestGenerationRequestId: state.allocatePullRequestGenerationRequestId,
      beginGitBranchCompareRequest: state.beginGitBranchCompareRequest,
      clearDiffComments: state.clearDiffComments,
      clearDiffCommentsForFile: state.clearDiffCommentsForFile,
      createHostedReview,
      createStackedHostedReview,
      deleteDiffComment: state.deleteDiffComment,
      enqueueGitHubPRRefresh: state.enqueueGitHubPRRefresh,
      ensureHostedReviewPushTarget: state.ensureHostedReviewPushTarget,
      fastForwardBranch: state.fastForwardBranch,
      fetchBranch: state.fetchBranch,
      fetchHostedReviewForBranch,
      fetchPRForBranch,
      fetchUpstreamStatus: state.fetchUpstreamStatus,
      getHostedReviewCreationEligibility,
      openAllDiffs,
      openBranchAllDiffs,
      openConflictReview,
      openModal: state.openModal,
      openSettingsPage: state.openSettingsPage,
      openSettingsTarget: state.openSettingsTarget,
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
      updateRepo,
      updateSettings: state.updateSettings,
      updateWorktreeGitIdentity: state.updateWorktreeGitIdentity,
      updateWorktreeMeta
    }
  }, [executionHostId, placementWorkspaceId, runtimeEnvironmentId])
}

export type SourceControlStoreActions = ReturnType<typeof useSourceControlStoreActions>
