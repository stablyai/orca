import type { SourceControlPanelFoundation } from '../panel/use-panel-foundation'
import { useSourceControlCreatePrIntentCommitMessage } from '../review/use-create-pr-intent-commit-message'
import { useSourceControlConflictAbort } from '../sync/use-conflict-abort'
import { useSourceControlConflictAdvance } from '../sync/use-conflict-advance'
import { useSourceControlRemoteActionRunner } from '../sync/use-remote-action-runner'
import { useSourceControlCommitAction } from './use-commit-action'
import { useSourceControlCommitMessageGeneration } from './use-commit-message-generation'

/**
 * Everything that writes to the local branch: the commit itself, the message it gets, the remote
 * ops that follow it, and the escape hatch out of a conflicted merge or rebase.
 */
export function useSourceControlCommitFlows(foundation: SourceControlPanelFoundation) {
  const {
    activeRepo,
    activeRepoSettings,
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
    isAdvancingOperation,
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
    setAdvanceOperationInFlightByWorktree,
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
    activeRepoSettings,
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
    activeRepoSettings,
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
    activeRepoSettings,
    activeWorktree,
    activeWorktreeId,
    branchName,
    effectiveBaseRef,
    fastForwardBranch,
    fetchBranch,
    grouped,
    handleCommit: commitAction.handleCommit,
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
    activeRepoSettings,
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
  const conflictAdvance = useSourceControlConflictAdvance({
    activeRepoSettings,
    activeWorktreeId,
    conflictOperation,
    isAbortingOperation,
    isAdvancingOperation,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    setAdvanceOperationInFlightByWorktree,
    setRemoteActionErrors,
    worktreePath
  })

  return {
    ...commitAction,
    ...commitMessageGeneration,
    ...createPrIntentCommitMessage,
    ...remoteActionRunner,
    ...conflictAbort,
    ...conflictAdvance
  }
}

export type SourceControlCommitFlows = ReturnType<typeof useSourceControlCommitFlows>
