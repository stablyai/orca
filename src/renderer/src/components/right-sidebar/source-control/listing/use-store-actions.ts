import { basename, getRelativePathInsideRoot } from '@/lib/path'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import type { AppState } from '@/store/types'
import {
  sourceControlScopeRuntimeEnvironmentId,
  useSourceControlScope
} from '../panel/worktree-scope'
import { useMemo } from 'react'
import { useAppStore } from '@/store'

const commands = {
  allocateCommitMessageGenerationRequestId: (
    ...args: Parameters<AppState['allocateCommitMessageGenerationRequestId']>
  ) => useAppStore.getState().allocateCommitMessageGenerationRequestId(...args),
  allocatePullRequestGenerationRequestId: (
    ...args: Parameters<AppState['allocatePullRequestGenerationRequestId']>
  ) => useAppStore.getState().allocatePullRequestGenerationRequestId(...args),
  beginGitBranchCompareRequest: (...args: Parameters<AppState['beginGitBranchCompareRequest']>) =>
    useAppStore.getState().beginGitBranchCompareRequest(...args),
  clearDiffComments: (...args: Parameters<AppState['clearDiffComments']>) =>
    useAppStore.getState().clearDiffComments(...args),
  clearDiffCommentsForFile: (...args: Parameters<AppState['clearDiffCommentsForFile']>) =>
    useAppStore.getState().clearDiffCommentsForFile(...args),
  deleteDiffComment: (...args: Parameters<AppState['deleteDiffComment']>) =>
    useAppStore.getState().deleteDiffComment(...args),
  enqueueGitHubPRRefresh: (...args: Parameters<AppState['enqueueGitHubPRRefresh']>) =>
    useAppStore.getState().enqueueGitHubPRRefresh(...args),
  ensureHostedReviewPushTarget: (...args: Parameters<AppState['ensureHostedReviewPushTarget']>) =>
    useAppStore.getState().ensureHostedReviewPushTarget(...args),
  fastForwardBranch: (...args: Parameters<AppState['fastForwardBranch']>) =>
    useAppStore.getState().fastForwardBranch(...args),
  fetchBranch: (...args: Parameters<AppState['fetchBranch']>) =>
    useAppStore.getState().fetchBranch(...args),
  fetchUpstreamStatus: (...args: Parameters<AppState['fetchUpstreamStatus']>) =>
    useAppStore.getState().fetchUpstreamStatus(...args),
  openModal: (...args: Parameters<AppState['openModal']>) =>
    useAppStore.getState().openModal(...args),
  openSettingsPage: (...args: Parameters<AppState['openSettingsPage']>) =>
    useAppStore.getState().openSettingsPage(...args),
  openSettingsTarget: (...args: Parameters<AppState['openSettingsTarget']>) =>
    useAppStore.getState().openSettingsTarget(...args),
  pullBranch: (...args: Parameters<AppState['pullBranch']>) =>
    useAppStore.getState().pullBranch(...args),
  pushBranch: (...args: Parameters<AppState['pushBranch']>) =>
    useAppStore.getState().pushBranch(...args),
  rebaseFromBase: (...args: Parameters<AppState['rebaseFromBase']>) =>
    useAppStore.getState().rebaseFromBase(...args),
  setCommitMessageGenerationRecord: (
    ...args: Parameters<AppState['setCommitMessageGenerationRecord']>
  ) => useAppStore.getState().setCommitMessageGenerationRecord(...args),
  setGitBranchCompareResult: (...args: Parameters<AppState['setGitBranchCompareResult']>) =>
    useAppStore.getState().setGitBranchCompareResult(...args),
  setGitStatus: (...args: Parameters<AppState['setGitStatus']>) =>
    useAppStore.getState().setGitStatus(...args),
  setPullRequestGenerationRecord: (
    ...args: Parameters<AppState['setPullRequestGenerationRecord']>
  ) => useAppStore.getState().setPullRequestGenerationRecord(...args),
  setRightSidebarOpen: (...args: Parameters<AppState['setRightSidebarOpen']>) =>
    useAppStore.getState().setRightSidebarOpen(...args),
  setRightSidebarTab: (...args: Parameters<AppState['setRightSidebarTab']>) =>
    useAppStore.getState().setRightSidebarTab(...args),
  setUpstreamStatus: (...args: Parameters<AppState['setUpstreamStatus']>) =>
    useAppStore.getState().setUpstreamStatus(...args),
  syncBranch: (...args: Parameters<AppState['syncBranch']>) =>
    useAppStore.getState().syncBranch(...args),
  updateCommitMessageGenerationRecord: (
    ...args: Parameters<AppState['updateCommitMessageGenerationRecord']>
  ) => useAppStore.getState().updateCommitMessageGenerationRecord(...args),
  updatePullRequestGenerationRecord: (
    ...args: Parameters<AppState['updatePullRequestGenerationRecord']>
  ) => useAppStore.getState().updatePullRequestGenerationRecord(...args),
  updateSettings: (...args: Parameters<AppState['updateSettings']>) =>
    useAppStore.getState().updateSettings(...args),
  updateWorktreeGitIdentity: (...args: Parameters<AppState['updateWorktreeGitIdentity']>) =>
    useAppStore.getState().updateWorktreeGitIdentity(...args)
}

/** Read fixed-identity actions via getState; key section wrappers on primitive routing so store writes never rebuild them. */
export function useSourceControlStoreActions() {
  const scope = useSourceControlScope()
  const executionHostId = scope?.executionHostId
  const placementWorkspaceId = scope?.placementWorkspaceId
  const runtimeEnvironmentId = sourceControlScopeRuntimeEnvironmentId(scope)

  return useMemo(() => {
    const options = { placementWorkspaceId, executionHostId, runtimeEnvironmentId }
    const createHostedReview: AppState['createHostedReview'] = (path, input) =>
      useAppStore.getState().createHostedReview(path, {
        ...input,
        ...(executionHostId ? { repoOwnerExecutionHostId: executionHostId } : {})
      })
    const createStackedHostedReview: AppState['createStackedHostedReview'] = (path, input) =>
      useAppStore.getState().createStackedHostedReview(path, {
        ...input,
        ...(executionHostId ? { repoOwnerExecutionHostId: executionHostId } : {})
      })
    const fetchHostedReviewForBranch: AppState['fetchHostedReviewForBranch'] = (
      path,
      branch,
      options
    ) =>
      useAppStore.getState().fetchHostedReviewForBranch(path, branch, {
        ...options,
        ...(executionHostId ? { repoOwnerExecutionHostId: executionHostId } : {})
      })
    const fetchPRForBranch: AppState['fetchPRForBranch'] = (path, branch, options) =>
      useAppStore.getState().fetchPRForBranch(path, branch, {
        ...options,
        ...(executionHostId ? { repoOwnerExecutionHostId: executionHostId } : {})
      })
    const getHostedReviewCreationEligibility: AppState['getHostedReviewCreationEligibility'] = (
      args
    ) =>
      useAppStore.getState().getHostedReviewCreationEligibility({
        ...args,
        ...(executionHostId ? { repoOwnerExecutionHostId: executionHostId } : {})
      })
    const openAllDiffs: AppState['openAllDiffs'] = (id, path, alternate, filter, entries) =>
      useAppStore.getState().openAllDiffs(id, path, alternate, filter, entries, options)
    const openBranchAllDiffs: AppState['openBranchAllDiffs'] = (id, path, compare, alternate) =>
      useAppStore.getState().openBranchAllDiffs(id, path, compare, alternate, options)
    const openConflictReview: AppState['openConflictReview'] = (id, path, entries, source) =>
      useAppStore.getState().openConflictReview(id, path, entries, source, options)
    const updateRepo: AppState['updateRepo'] = (id, updates, options) =>
      useAppStore.getState().updateRepo(id, updates, {
        ...options,
        ...(executionHostId ? { hostId: executionHostId } : {})
      })
    const updateWorktreeMeta: AppState['updateWorktreeMeta'] = (id, updates, options) =>
      useAppStore.getState().updateWorktreeMeta(id, updates, {
        ...options,
        ...(executionHostId ? { executionHostId } : {})
      })
    const revealInExplorer: AppState['revealInExplorer'] = (id, path) => {
      if (!placementWorkspaceId) {
        useAppStore.getState().revealInExplorer(id, path)
        return
      }
      const latest = useAppStore.getState()
      const groupId = latest.activeGroupIdByWorktree[placementWorkspaceId]
      const root = latest.getKnownWorktreeById(id, executionHostId)?.path ?? null
      useAppStore.getState().openFile(
        {
          filePath: path,
          relativePath: getRelativePathInsideRoot(path, root) ?? basename(path),
          worktreeId: id,
          language: detectLanguage(path),
          mode: 'edit',
          runtimeEnvironmentId
        },
        {
          ...options,
          targetGroupId: groupId,
          preview: false
        }
      )
    }
    return {
      allocateCommitMessageGenerationRequestId: commands.allocateCommitMessageGenerationRequestId,
      allocatePullRequestGenerationRequestId: commands.allocatePullRequestGenerationRequestId,
      beginGitBranchCompareRequest: commands.beginGitBranchCompareRequest,
      clearDiffComments: commands.clearDiffComments,
      clearDiffCommentsForFile: commands.clearDiffCommentsForFile,
      createHostedReview,
      createStackedHostedReview,
      deleteDiffComment: commands.deleteDiffComment,
      enqueueGitHubPRRefresh: commands.enqueueGitHubPRRefresh,
      ensureHostedReviewPushTarget: commands.ensureHostedReviewPushTarget,
      fastForwardBranch: commands.fastForwardBranch,
      fetchBranch: commands.fetchBranch,
      fetchHostedReviewForBranch,
      fetchPRForBranch,
      fetchUpstreamStatus: commands.fetchUpstreamStatus,
      getHostedReviewCreationEligibility,
      openAllDiffs,
      openBranchAllDiffs,
      openConflictReview,
      openModal: commands.openModal,
      openSettingsPage: commands.openSettingsPage,
      openSettingsTarget: commands.openSettingsTarget,
      pullBranch: commands.pullBranch,
      pushBranch: commands.pushBranch,
      rebaseFromBase: commands.rebaseFromBase,
      revealInExplorer,
      setCommitMessageGenerationRecord: commands.setCommitMessageGenerationRecord,
      setGitBranchCompareResult: commands.setGitBranchCompareResult,
      setGitStatus: commands.setGitStatus,
      setPullRequestGenerationRecord: commands.setPullRequestGenerationRecord,
      setRightSidebarOpen: commands.setRightSidebarOpen,
      setRightSidebarTab: commands.setRightSidebarTab,
      setUpstreamStatus: commands.setUpstreamStatus,
      syncBranch: commands.syncBranch,
      updateCommitMessageGenerationRecord: commands.updateCommitMessageGenerationRecord,
      updatePullRequestGenerationRecord: commands.updatePullRequestGenerationRecord,
      updateRepo,
      updateSettings: commands.updateSettings,
      updateWorktreeGitIdentity: commands.updateWorktreeGitIdentity,
      updateWorktreeMeta
    }
  }, [executionHostId, placementWorkspaceId, runtimeEnvironmentId])
}

export type SourceControlStoreActions = ReturnType<typeof useSourceControlStoreActions>
