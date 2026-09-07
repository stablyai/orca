import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { createCreatePrIntentRunToken } from './create-pr-intent-flow'
import type { SourceControlCommitAction } from '../commit/use-commit-action'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlFileListing } from '../listing/use-file-listing'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { SourceControlRemoteActionRunner } from '../sync/use-remote-action-runner'
import { runCreatePrIntentBranchPrep } from './create-pr-intent-branch-prep'
import { runCreatePrIntentReviewStep } from './create-pr-intent-review-step'
import { createCreatePrIntentRunSnapshot } from './create-pr-intent-run-snapshot'
import type { SourceControlCreatePrIntentCommitMessage } from './use-create-pr-intent-commit-message'
import type { SourceControlCreatePrIntentProbes } from './use-create-pr-intent-probes'
import type { SourceControlCreatePrIntentReview } from './use-create-pr-intent-review'
import type { SourceControlCreatePrIntentTarget } from './use-create-pr-intent-target'
import type { SourceControlHostedReviewProviderHint } from './use-hosted-review-provider-hint'

/**
 * One-click "Create PR": commits, pushes, and opens the review, refusing to continue the moment the
 * run no longer owns the worktree it started on.
 */
export function useSourceControlCreatePrIntentRun({
  activeRepo,
  activeWorktreeId,
  branchName,
  commitDraftsRef,
  commitErrorsRef,
  createHostedReviewForCreatePrIntent,
  createPrIntentActiveTargetConflicts,
  createPrIntentInFlightRef,
  createPrIntentRunStillOwnsWorktree,
  createPrIntentRunTokenRef,
  effectiveBaseRef,
  entries,
  generateCommitMessageForCreatePrIntent,
  getCreatePrIntentOperationTarget,
  handleCommit,
  isCommitting,
  isCreatingPr,
  isExecutingBulk,
  isGenerating,
  isRemoteOperationActive,
  prGenerating,
  provisionalHostedReviewProvider,
  readHostedReviewCreationEligibilityForIntent,
  refreshBranchCompareForCreatePrIntent,
  refreshGitStatusForCreatePrIntent,
  remoteStatus,
  runRemoteAction,
  setCreatePrIntentInFlightByWorktree,
  setCreatePrIntentNoticeForWorktree,
  setIsExecutingBulk,
  updateCommitDrafts,
  worktreePath
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeWorktreeId: string | null
  branchName: string
  commitDraftsRef: SourceControlWorktreeOperationState['commitDraftsRef']
  commitErrorsRef: SourceControlWorktreeOperationState['commitErrorsRef']
  createHostedReviewForCreatePrIntent: SourceControlCreatePrIntentReview['createHostedReviewForCreatePrIntent']
  createPrIntentActiveTargetConflicts: SourceControlWorktreeOperationState['createPrIntentActiveTargetConflicts']
  createPrIntentInFlightRef: SourceControlWorktreeOperationState['createPrIntentInFlightRef']
  createPrIntentRunStillOwnsWorktree: SourceControlWorktreeOperationState['createPrIntentRunStillOwnsWorktree']
  createPrIntentRunTokenRef: SourceControlWorktreeOperationState['createPrIntentRunTokenRef']
  effectiveBaseRef: string | null
  entries: SourceControlWorktreeContext['entries']
  generateCommitMessageForCreatePrIntent: SourceControlCreatePrIntentCommitMessage['generateCommitMessageForCreatePrIntent']
  getCreatePrIntentOperationTarget: SourceControlCreatePrIntentTarget['getCreatePrIntentOperationTarget']
  handleCommit: SourceControlCommitAction['handleCommit']
  isCommitting: boolean
  isCreatingPr: boolean
  isExecutingBulk: SourceControlFileListing['isExecutingBulk']
  isGenerating: boolean
  isRemoteOperationActive: boolean
  prGenerating: boolean
  provisionalHostedReviewProvider: SourceControlHostedReviewProviderHint['provisionalHostedReviewProvider']
  readHostedReviewCreationEligibilityForIntent: SourceControlCreatePrIntentProbes['readHostedReviewCreationEligibilityForIntent']
  refreshBranchCompareForCreatePrIntent: SourceControlCreatePrIntentProbes['refreshBranchCompareForCreatePrIntent']
  refreshGitStatusForCreatePrIntent: SourceControlCreatePrIntentProbes['refreshGitStatusForCreatePrIntent']
  remoteStatus: SourceControlWorktreeContext['remoteStatus']
  runRemoteAction: SourceControlRemoteActionRunner['runRemoteAction']
  setCreatePrIntentInFlightByWorktree: SourceControlWorktreeOperationState['setCreatePrIntentInFlightByWorktree']
  setCreatePrIntentNoticeForWorktree: SourceControlWorktreeOperationState['setCreatePrIntentNoticeForWorktree']
  setIsExecutingBulk: SourceControlFileListing['setIsExecutingBulk']
  updateCommitDrafts: SourceControlWorktreeOperationState['updateCommitDrafts']
  worktreePath: string | null
}): { runCreatePrIntent: () => Promise<void> } {
  const runCreatePrIntent = useCallback(async (): Promise<void> => {
    if (
      !activeRepo ||
      !activeWorktreeId ||
      !worktreePath ||
      !branchName ||
      isExecutingBulk ||
      isCommitting ||
      isGenerating ||
      isRemoteOperationActive ||
      prGenerating ||
      isCreatingPr ||
      createPrIntentInFlightRef.current[activeWorktreeId]
    ) {
      return
    }

    const token = createCreatePrIntentRunToken({
      repoId: activeRepo.id,
      worktreeId: activeWorktreeId,
      worktreePath,
      branch: branchName,
      // Why: token carries the same provisional provider used for UI copy so a failed
      // eligibility IPC can synthesize local prep steps for the correct host.
      provider: provisionalHostedReviewProvider,
      // Why: intent crosses async commit/push steps, so the base stays tied to what was selected when the run started.
      baseRef: effectiveBaseRef ?? null
    })
    const operationTarget = getCreatePrIntentOperationTarget(token)
    const snapshot = createCreatePrIntentRunSnapshot({
      initialEntries: entries,
      initialUpstreamStatus: remoteStatus,
      operationTarget,
      refreshGitStatusForCreatePrIntent,
      runIsCurrent: () =>
        createPrIntentRunStillOwnsWorktree(token) && !createPrIntentActiveTargetConflicts(token),
      setIsExecutingBulk,
      token
    })
    createPrIntentRunTokenRef.current[token.worktreeId] = token
    createPrIntentInFlightRef.current[token.worktreeId] = true
    setCreatePrIntentInFlightByWorktree((prev) => ({ ...prev, [token.worktreeId]: true }))
    setCreatePrIntentNoticeForWorktree(token.worktreeId, {
      tone: 'muted',
      message: translate(
        'auto.components.right.sidebar.SourceControl.d37e68f61d',
        'Preparing branch for review…'
      )
    })

    try {
      const prepared = await runCreatePrIntentBranchPrep({
        commitDraftsRef,
        commitErrorsRef,
        generateCommitMessageForCreatePrIntent,
        handleCommit,
        operationTarget,
        runRemoteAction,
        setCreatePrIntentNoticeForWorktree,
        snapshot,
        token,
        updateCommitDrafts
      })
      if (!prepared) {
        return
      }
      await runCreatePrIntentReviewStep({
        createHostedReviewForCreatePrIntent,
        operationTarget,
        readHostedReviewCreationEligibilityForIntent,
        refreshBranchCompareForCreatePrIntent,
        runRemoteAction,
        setCreatePrIntentNoticeForWorktree,
        snapshot,
        token
      })
    } catch (error) {
      console.warn('[SourceControl] Create PR intent failed', error)
      if (!snapshot.abortIfStale()) {
        setCreatePrIntentNoticeForWorktree(token.worktreeId, {
          tone: 'destructive',
          message: translate(
            'auto.components.right.sidebar.SourceControl.d7492cafce',
            'Could not refresh Source Control. Retry Create PR.'
          )
        })
      }
    } finally {
      if (createPrIntentRunTokenRef.current[token.worktreeId] === token) {
        createPrIntentInFlightRef.current[token.worktreeId] = false
        createPrIntentRunTokenRef.current[token.worktreeId] = null
        if (snapshot.wasAbortedByStaleTarget()) {
          setCreatePrIntentNoticeForWorktree(token.worktreeId, null)
        }
        setCreatePrIntentInFlightByWorktree((prev) => ({
          ...prev,
          [token.worktreeId]: false
        }))
      }
    }
  }, [
    activeRepo,
    activeWorktreeId,
    branchName,
    commitDraftsRef,
    commitErrorsRef,
    createPrIntentActiveTargetConflicts,
    createPrIntentInFlightRef,
    createPrIntentRunStillOwnsWorktree,
    createPrIntentRunTokenRef,
    createHostedReviewForCreatePrIntent,
    effectiveBaseRef,
    entries,
    generateCommitMessageForCreatePrIntent,
    getCreatePrIntentOperationTarget,
    handleCommit,
    isCommitting,
    isCreatingPr,
    isExecutingBulk,
    isGenerating,
    isRemoteOperationActive,
    prGenerating,
    readHostedReviewCreationEligibilityForIntent,
    refreshGitStatusForCreatePrIntent,
    refreshBranchCompareForCreatePrIntent,
    provisionalHostedReviewProvider,
    remoteStatus,
    runRemoteAction,
    setCreatePrIntentInFlightByWorktree,
    setCreatePrIntentNoticeForWorktree,
    setIsExecutingBulk,
    updateCommitDrafts,
    worktreePath
  ])

  return { runCreatePrIntent }
}
