import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { isGitHubPRSuppressed } from '../../../../../../shared/worktree/github-pr-suppression'
import {
  prDetailRecoveryContextKey,
  prDetailRecoverySelectionRevision,
  type PRDetailRecoveryContext
} from '@/store/github/pull-requests/pr-detail-recovery-context'
import type { ChecksPanelContextState } from '../use-checks-panel-context-state'
import type { ChecksPanelControllerState } from '../use-checks-panel-controller-state'
import type { ChecksPanelReviewState } from '../use-checks-panel-review-state'

type Model = Pick<
  ChecksPanelControllerState,
  'activeWorktree' | 'branch' | 'repo' | 'isPanelVisible'
> &
  Pick<
    ChecksPanelContextState,
    'hostedReview' | 'hostedReviewCacheKey' | 'isFolder' | 'linkedPR' | 'pr' | 'suppressedGitHubPR'
  > &
  Pick<
    ChecksPanelReviewState,
    'checksPanelReviewLookupResult' | 'hostedReviewCreation' | 'isGitHubReviewContext'
  >

function recoveryContext(model: Model): PRDetailRecoveryContext | null {
  const { activeWorktree: worktree, branch, repo, linkedPR } = model
  const lookup = model.checksPanelReviewLookupResult
  const positive =
    lookup.state === 'positive_unresolved' ||
    model.hostedReviewCreation?.blockedReason === 'existing_review'
  const number = lookup.reviewNumber ?? model.hostedReviewCreation?.review?.number ?? null
  if (
    !worktree ||
    !repo ||
    !branch ||
    model.isFolder ||
    !model.isGitHubReviewContext ||
    model.hostedReview?.provider === 'gitlab' ||
    !positive ||
    model.pr !== null ||
    number === null ||
    (linkedPR !== null && number !== linkedPR) ||
    isGitHubPRSuppressed({ linkedPR, suppressedGitHubPR: model.suppressedGitHubPR }, number)
  ) {
    return null
  }
  return {
    worktreeId: worktree.id,
    repoId: repo.id,
    repoPath: repo.path,
    executionHostId: getRepoExecutionHostId(repo),
    branch,
    headOid: worktree.head ?? null,
    linkedPRNumber: linkedPR,
    hintPRNumber: linkedPR === null ? number : null,
    hostedReviewCacheKey: model.hostedReviewCacheKey,
    selectionRevision: prDetailRecoverySelectionRevision(worktree)
  }
}

/** The visible Checks panel asks the store for one automatic detail read per context and exposure. */
export function useChecksPanelPRDetailRecovery(model: Model): {
  prDetailRecoveryContextKey: string | null
} {
  const notePanelVisible = useAppStore((s) => s.notePRDetailRecoveryPanelVisible)
  const reconcile = useAppStore((s) => s.reconcileGitHubPRDetails)
  // The sidebar stays mounted while closed: exposure follows real visibility, not mount.
  const visible = model.isPanelVisible
  useEffect(() => {
    notePanelVisible(visible)
  }, [notePanelVisible, visible])
  useEffect(() => () => notePanelVisible(false), [notePanelVisible])
  const context = visible ? recoveryContext(model) : null
  // Primitive deps: the context object is rebuilt each render, its fields are what the store submits.
  const eligible = context !== null
  const worktreeId = context?.worktreeId ?? ''
  const repoId = context?.repoId ?? ''
  const repoPath = context?.repoPath ?? ''
  const executionHostId = context?.executionHostId ?? ''
  const branch = context?.branch ?? ''
  const headOid = context?.headOid ?? null
  const linkedPRNumber = context?.linkedPRNumber ?? null
  const hintPRNumber = context?.hintPRNumber ?? null
  const hostedReviewCacheKey = context?.hostedReviewCacheKey ?? ''
  const selectionRevision = context?.selectionRevision ?? ''
  useEffect(() => {
    reconcile(
      eligible
        ? {
            worktreeId,
            repoId,
            repoPath,
            executionHostId,
            branch,
            headOid,
            linkedPRNumber,
            hintPRNumber,
            hostedReviewCacheKey,
            selectionRevision
          }
        : null
    )
  }, [
    eligible,
    worktreeId,
    repoId,
    repoPath,
    executionHostId,
    branch,
    headOid,
    linkedPRNumber,
    hintPRNumber,
    hostedReviewCacheKey,
    selectionRevision,
    reconcile
  ])
  return { prDetailRecoveryContextKey: context ? prDetailRecoveryContextKey(context) : null }
}
