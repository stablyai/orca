import { useSourceControlScope } from '../panel/worktree-scope'
import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { createCreatePrIntentRunToken } from './create-pr-intent-flow'
import { resolveWorktreeGitCopyNow } from '@/lib/worktree-git-copy'
import type { SourceControlCommitAction } from '../commit/use-commit-action'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlFileListing } from '../listing/use-file-listing'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import {
  createPrIntentRunIsCurrent,
  setCreatePrIntentNotice
} from '../panel/worktree-operation-store'
import type { CreatePrIntentNotice } from '../commit/commit-area-types'
import type { SourceControlRemoteActionRunner } from '../sync/use-remote-action-runner'
import { runCreatePrIntentBranchPrep } from './create-pr-intent-branch-prep'
import { runCreatePrIntentReviewStep } from './create-pr-intent-review-step'
import { createCreatePrIntentRunSnapshot } from './create-pr-intent-run-snapshot'
import type { SourceControlCreatePrIntentCommitMessage } from './use-create-pr-intent-commit-message'
import type { SourceControlCreatePrIntentProbes } from './use-create-pr-intent-probes'
import type { SourceControlCreatePrIntentReview } from './use-create-pr-intent-review'
import type { SourceControlCreatePrIntentTarget } from './use-create-pr-intent-target'
import type { SourceControlHostedReviewProviderHint } from './use-hosted-review-provider-hint'

export function useSourceControlCreatePrIntentRun({
  activeRepo,
  activeWorktreeId,
  branchName,
  createHostedReviewForCreatePrIntent,
  effectiveBaseRef,
  entries,
  generateCommitMessageForCreatePrIntent,
  getCreatePrIntentOperationTarget,
  handleCommit,
  isExecutingBulk,
  isGenerating,
  isRemoteOperationActive,
  operationStore,
  prGenerating,
  provisionalHostedReviewProvider,
  readHostedReviewCreationEligibilityForIntent,
  refreshBranchCompareForCreatePrIntent,
  refreshGitStatusForCreatePrIntent,
  remoteStatus,
  runRemoteAction,
  setIsExecutingBulk,
  updateCommitDraft,
  worktreePath
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeWorktreeId: string | null
  branchName: string
  createHostedReviewForCreatePrIntent: SourceControlCreatePrIntentReview['createHostedReviewForCreatePrIntent']
  effectiveBaseRef: string | null
  entries: SourceControlWorktreeContext['entries']
  generateCommitMessageForCreatePrIntent: SourceControlCreatePrIntentCommitMessage['generateCommitMessageForCreatePrIntent']
  getCreatePrIntentOperationTarget: SourceControlCreatePrIntentTarget['getCreatePrIntentOperationTarget']
  handleCommit: SourceControlCommitAction['handleCommit']
  isExecutingBulk: SourceControlFileListing['isExecutingBulk']
  isGenerating: boolean
  isRemoteOperationActive: boolean
  operationStore: SourceControlWorktreeOperationState['operationStore']
  prGenerating: boolean
  provisionalHostedReviewProvider: SourceControlHostedReviewProviderHint['provisionalHostedReviewProvider']
  readHostedReviewCreationEligibilityForIntent: SourceControlCreatePrIntentProbes['readHostedReviewCreationEligibilityForIntent']
  refreshBranchCompareForCreatePrIntent: SourceControlCreatePrIntentProbes['refreshBranchCompareForCreatePrIntent']
  refreshGitStatusForCreatePrIntent: SourceControlCreatePrIntentProbes['refreshGitStatusForCreatePrIntent']
  remoteStatus: SourceControlWorktreeContext['remoteStatus']
  runRemoteAction: SourceControlRemoteActionRunner['runRemoteAction']
  setIsExecutingBulk: SourceControlFileListing['setIsExecutingBulk']
  updateCommitDraft: SourceControlWorktreeOperationState['updateCommitDraft']
  worktreePath: string | null
}): { runCreatePrIntent: () => Promise<void> } {
  const scope = useSourceControlScope()
  const runCreatePrIntent = useCallback(async (): Promise<void> => {
    if (
      !activeRepo ||
      !activeWorktreeId ||
      !worktreePath ||
      !branchName ||
      isExecutingBulk ||
      isGenerating ||
      isRemoteOperationActive ||
      prGenerating
    ) {
      return
    }
    const { createPrIntentRun, isCommitting, isCreatingPr } = operationStore.getState()
    if (createPrIntentRun || isCommitting || isCreatingPr) {
      return
    }

    const token = createCreatePrIntentRunToken({
      repoId: activeRepo.id,
      worktreeId: activeWorktreeId,
      worktreePath,
      branch: branchName,
      // Preserve the UI provider so failed eligibility probes can synthesize the right host’s local prep steps.
      provider: provisionalHostedReviewProvider,
      // Pin the selected base across asynchronous commit/push steps.
      baseRef: effectiveBaseRef ?? null,
      // The run outlives navigation; its git answers stay on the copy it started from.
      pinnedCopy: resolveWorktreeGitCopyNow(activeWorktreeId, scope?.executionHostId)
    })
    const operationTarget = getCreatePrIntentOperationTarget(token)
    const snapshot = createCreatePrIntentRunSnapshot({
      initialEntries: entries,
      initialUpstreamStatus: remoteStatus,
      operationTarget,
      refreshGitStatusForCreatePrIntent,
      runIsCurrent: () => createPrIntentRunIsCurrent(operationStore, token),
      setIsExecutingBulk,
      token
    })
    const setNotice = (notice: CreatePrIntentNotice | null): void =>
      setCreatePrIntentNotice(operationStore, notice)
    operationStore.setState({ createPrIntentRun: token })
    setNotice({
      tone: 'muted',
      message: translate(
        'auto.components.right.sidebar.SourceControl.d37e68f61d',
        'Preparing branch for review…'
      )
    })

    try {
      const prepared = await runCreatePrIntentBranchPrep({
        generateCommitMessageForCreatePrIntent,
        handleCommit,
        operationStore,
        operationTarget,
        runRemoteAction,
        setCreatePrIntentNotice: setNotice,
        snapshot,
        token,
        updateCommitDraft
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
        setCreatePrIntentNotice: setNotice,
        snapshot,
        token
      })
    } catch (error) {
      console.warn('[SourceControl] Create PR intent failed', error)
      if (!snapshot.abortIfStale()) {
        setNotice({
          tone: 'destructive',
          message: translate(
            'auto.components.right.sidebar.SourceControl.d7492cafce',
            'Could not refresh Source Control. Retry Create PR.'
          )
        })
      }
    } finally {
      if (operationStore.getState().createPrIntentRun === token) {
        operationStore.setState({
          createPrIntentRun: null,
          ...(snapshot.wasAbortedByStaleTarget() ? { createPrIntentNotice: null } : {})
        })
      }
    }
  }, [
    activeRepo,
    activeWorktreeId,
    branchName,
    createHostedReviewForCreatePrIntent,
    effectiveBaseRef,
    entries,
    generateCommitMessageForCreatePrIntent,
    getCreatePrIntentOperationTarget,
    handleCommit,
    isExecutingBulk,
    isGenerating,
    isRemoteOperationActive,
    operationStore,
    prGenerating,
    readHostedReviewCreationEligibilityForIntent,
    refreshGitStatusForCreatePrIntent,
    refreshBranchCompareForCreatePrIntent,
    provisionalHostedReviewProvider,
    remoteStatus,
    runRemoteAction,
    scope?.executionHostId,
    setIsExecutingBulk,
    updateCommitDraft,
    worktreePath
  ])

  return { runCreatePrIntent }
}
