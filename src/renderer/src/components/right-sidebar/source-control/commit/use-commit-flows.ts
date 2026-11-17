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
    commitMessage,
    compareBaseRef,
    conflictOperation,
    effectiveBaseRef,
    fastForwardBranch,
    fetchBranch,
    getCreatePrIntentOperationTarget,
    grouped,
    openCommitGenerationDialog,
    operationStore,
    pullBranch,
    pushBranch,
    rebaseFromBase,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    remoteStatus,
    remoteStatusForActions,
    setCommitMessageGenerationRecord,
    syncBranch,
    unresolvedConflicts,
    updateCommitDraft,
    updateCommitMessageGenerationRecord,
    worktreePath
  } = foundation

  const commitAction = useSourceControlCommitAction({
    activeRepoTarget,
    activeWorktree,
    activeWorktreeId,
    beginGitBranchCompareRequest,
    commitMessage,
    compareBaseRef,
    operationStore,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    stagedCount: grouped.staged.length,
    unresolvedConflictCount: unresolvedConflicts.length,
    updateCommitDraft,
    worktreePath
  })
  const commitMessageGeneration = useSourceControlCommitMessageGeneration({
    activeRepo,
    activeRepoTarget,
    activeWorktreeId,
    allocateCommitMessageGenerationRequestId,
    openCommitGenerationDialog,
    operationStore,
    setCommitMessageGenerationRecord,
    updateCommitDraft,
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
    getCreatePrIntentOperationTarget,
    operationStore
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
    operationStore,
    pullBranch,
    pushBranch,
    rebaseFromBase,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    remoteStatus,
    remoteStatusForActions,
    syncBranch,
    worktreePath
  })
  const conflictAbort = useSourceControlConflictAbort({
    activeRepoTarget,
    activeWorktreeId,
    conflictOperation,
    operationStore,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
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
