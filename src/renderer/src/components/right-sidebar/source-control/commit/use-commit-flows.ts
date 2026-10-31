import { useCallback } from 'react'
import type { SourceControlPanelFoundation } from '../panel/use-panel-foundation'
import { useSourceControlCreatePrIntentCommitMessage } from '../review/use-create-pr-intent-commit-message'
import { useSourceControlConflictAbort } from '../sync/use-conflict-abort'
import { useSourceControlRemoteActionRunner } from '../sync/use-remote-action-runner'
import { useSourceControlCommitAction } from './use-commit-action'
import { useSourceControlCommitMessageGeneration } from './use-commit-message-generation'

export function useSourceControlCommitFlows(foundation: SourceControlPanelFoundation) {
  const {
    activeRepo,
    activeRepoTarget,
    activeWorktree,
    activeWorktreeId,
    allocateCommitMessageGenerationRequestId,
    beginGitBranchCompareRequest,
    branchName,
    commitInFlightRef,
    commitMessage,
    commitMessageGenerationRecords,
    compareBaseRef,
    conflictOperation,
    effectiveBaseRef,
    fastForwardBranch,
    fetchBranch,
    generateErrors,
    generateInFlightByWorktree,
    generateInFlightRef,
    getCreatePrIntentOperationTarget,
    grouped,
    isAbortingOperation,
    openCommitGenerationDialog,
    pullBranch,
    pushBranch,
    rebaseFromBase,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    remoteActionErrorSequenceByWorktreeRef,
    remoteStatus,
    remoteStatusForActions,
    resolvedCommitMessageAi,
    setAbortOperationInFlightByWorktree,
    setCommitErrorForWorktree,
    setCommitInFlightByWorktree,
    setCommitMessageGenerationRecord,
    setGenerateErrors,
    setGenerateInFlightByWorktree,
    setRemoteActionErrors,
    settings,
    sourceControlAiActionsVisible,
    syncBranch,
    unresolvedConflicts,
    updateCommitDrafts,
    updateCommitMessageGenerationRecord,
    worktreePath
  } = foundation

  const commitAction = useSourceControlCommitAction({
    activeRepoTarget,
    activeWorktree,
    activeWorktreeId,
    beginGitBranchCompareRequest,
    commitInFlightRef,
    commitMessage,
    compareBaseRef,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    setCommitErrorForWorktree,
    setCommitInFlightByWorktree,
    stagedCount: grouped.staged.length,
    unresolvedConflictCount: unresolvedConflicts.length,
    updateCommitDrafts,
    worktreePath
  })
  const commitMessageGeneration = useSourceControlCommitMessageGeneration({
    activeRepo,
    activeRepoTarget,
    activeWorktreeId,
    allocateCommitMessageGenerationRequestId,
    commitMessageGenerationRecords,
    generateErrors,
    generateInFlightByWorktree,
    generateInFlightRef,
    openCommitGenerationDialog,
    resolvedCommitMessageAi,
    setCommitMessageGenerationRecord,
    setGenerateErrors,
    setGenerateInFlightByWorktree,
    settings,
    sourceControlAiActionsVisible,
    updateCommitDrafts,
    updateCommitMessageGenerationRecord,
    worktreePath
  })
  const { handleCommit: commitStagedChanges, handleCompleteMerge } = commitAction
  const { handleCancelGenerate } = commitMessageGeneration
  // Cancel box generation when committing its draft so a late reply cannot refill it; Create PR has its own target.
  const handleCommit = useCallback<typeof commitStagedChanges>(
    (messageOverride, options) => {
      if (!options?.target) {
        handleCancelGenerate()
      }
      return commitStagedChanges(messageOverride, options)
    },
    [commitStagedChanges, handleCancelGenerate]
  )
  const createPrIntentCommitMessage = useSourceControlCreatePrIntentCommitMessage({
    activeRepo,
    generateInFlightRef,
    getCreatePrIntentOperationTarget,
    resolvedCommitMessageAi,
    setGenerateErrors,
    setGenerateInFlightByWorktree,
    settings
  })
  const remoteActionRunner = useSourceControlRemoteActionRunner({
    activeRepoTarget,
    activeWorktree,
    activeWorktreeId,
    branchName,
    effectiveBaseRef,
    fastForwardBranch,
    fetchBranch,
    grouped,
    handleCommit,
    pullBranch,
    pushBranch,
    rebaseFromBase,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    remoteActionErrorSequenceByWorktreeRef,
    remoteStatus,
    remoteStatusForActions,
    setRemoteActionErrors,
    syncBranch,
    worktreePath
  })
  const conflictAbort = useSourceControlConflictAbort({
    activeRepoTarget,
    activeWorktreeId,
    conflictOperation,
    isAbortingOperation,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    setAbortOperationInFlightByWorktree,
    setRemoteActionErrors,
    worktreePath
  })

  return {
    handleCommit,
    handleCompleteMerge,
    ...commitMessageGeneration,
    ...createPrIntentCommitMessage,
    ...remoteActionRunner,
    ...conflictAbort
  }
}

export type SourceControlCommitFlows = ReturnType<typeof useSourceControlCommitFlows>
