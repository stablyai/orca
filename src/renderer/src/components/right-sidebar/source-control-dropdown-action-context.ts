// Why: every row's label and disabled state reads the same handful of derived branch/review facts.
// Deriving them once keeps the rows consistent — a row computing `hasUpstream` its own way is how
// Publish and Push drift apart.

import type { PrimaryActionInputs } from './source-control-primary-action'
import { canSubmitCommit, resolveCommitDisabledReason } from './source-control-commit-eligibility'
import type { GitConflictOperation } from '../../../../shared/git-status-types'
import { shouldForcePushWithLeaseForUpstream } from '../../../../shared/git-upstream-status'
import type { DropdownActionInputs } from './source-control-dropdown-item-types'
import { formatForcePushTitle } from './source-control-dropdown-labels'

export type DropdownActionContext = {
  upstreamStatus: PrimaryActionInputs['upstreamStatus']
  hostedReviewCreation: PrimaryActionInputs['hostedReviewCreation']
  branchCommitsAhead: number | undefined
  conflictOperation: GitConflictOperation
  isPullRequestOperationActive: boolean
  canPushLinkedReviewWithoutUpstream: boolean
  rebaseBaseRef: string | null | undefined
  hasDirtyLocalChanges: boolean
  upstreamLoading: boolean
  hasUpstream: boolean
  hasOpenHostedReview: boolean
  canPushUntrackedHostedReview: boolean
  pushBlockedByOpenHostedReviewTarget: boolean
  publishBlockedByMergedPR: boolean
  publishBlockedByPRLoading: boolean
  publishBlockedByOpenHostedReview: boolean
  publishBlockedByDetachedHead: boolean
  ahead: number
  behind: number
  shouldForcePushWithLease: boolean
  pushLabelCount: number
  forcePushTitle: string
  globalBusy: boolean
  commitDisabledReason: ReturnType<typeof resolveCommitDisabledReason>
  canCommit: boolean
}

export function deriveDropdownActionContext(inputs: DropdownActionInputs): DropdownActionContext {
  const {
    stagedCount,
    hasPartiallyStagedChanges,
    hasMessage,
    hasUnresolvedConflicts,
    isCommitting,
    isRemoteOperationActive,
    upstreamStatus,
    prState,
    isPRStateLoading,
    hostedReviewCreation,
    conflictOperation = 'unknown',
    branchCommitsAhead,
    hasCurrentBranch = true,
    canPushLinkedReviewWithoutUpstream = false,
    rebaseBaseRef,
    isPullRequestOperationActive = false
  } = inputs

  const hasStaged = stagedCount > 0
  const hasDirtyLocalChanges = hasStaged || inputs.hasUnstagedChanges
  // Why: undefined upstreamStatus means loading (transient after a worktree switch), not unpublished — treating it as hasUpstream=false would re-enable Publish Branch and clobber the real upstream.
  const upstreamLoading = upstreamStatus === undefined
  const hasUpstream = upstreamStatus?.hasUpstream ?? false
  const hasOpenHostedReview = prState === 'open' || prState === 'draft'
  const canPushUntrackedHostedReview =
    !hasUpstream &&
    hasOpenHostedReview &&
    hasCurrentBranch &&
    branchCommitsAhead !== 0 &&
    canPushLinkedReviewWithoutUpstream
  // Why: only a missing review head hard-blocks; branchCommitsAhead === 0 still means the target is known, so Push stays available.
  const pushBlockedByOpenHostedReviewTarget =
    !hasUpstream && hasOpenHostedReview && !canPushLinkedReviewWithoutUpstream
  const publishBlockedByMergedPR = !hasUpstream && prState === 'merged'
  const publishBlockedByPRLoading = !hasUpstream && !!isPRStateLoading
  const publishBlockedByOpenHostedReview = !hasUpstream && hasOpenHostedReview
  const publishBlockedByDetachedHead = !hasUpstream && !hasCurrentBranch
  const ahead = upstreamStatus?.ahead ?? 0
  const behind = upstreamStatus?.behind ?? 0
  const shouldForcePushWithLease = shouldForcePushWithLeaseForUpstream(upstreamStatus)
  // Why: prefer branch-compare for force-push counts — unpublished/loading branches report ahead=0 and patch-equivalent rewrites inflate upstream ahead.
  const pushLabelCount =
    branchCommitsAhead !== undefined &&
    branchCommitsAhead > 0 &&
    (shouldForcePushWithLease || !hasUpstream)
      ? branchCommitsAhead
      : ahead
  const forcePushTitle = formatForcePushTitle(branchCommitsAhead, upstreamStatus?.upstreamName)

  // Why: lock the whole menu during any in-flight op so a second click can't queue on a stale status snapshot.
  const globalBusy = isCommitting || isRemoteOperationActive || isPullRequestOperationActive

  const commitDisabledReason = resolveCommitDisabledReason({
    stagedCount,
    hasPartiallyStagedChanges,
    hasMessage,
    hasUnresolvedConflicts
  })
  const canCommit =
    !globalBusy &&
    canSubmitCommit({
      stagedCount,
      hasPartiallyStagedChanges,
      hasMessage,
      hasUnresolvedConflicts,
      isCommitting,
      isRemoteOperationActive,
      isPullRequestOperationActive
    })

  return {
    upstreamStatus,
    hostedReviewCreation,
    branchCommitsAhead,
    conflictOperation,
    isPullRequestOperationActive,
    canPushLinkedReviewWithoutUpstream,
    rebaseBaseRef,
    hasDirtyLocalChanges,
    upstreamLoading,
    hasUpstream,
    hasOpenHostedReview,
    canPushUntrackedHostedReview,
    pushBlockedByOpenHostedReviewTarget,
    publishBlockedByMergedPR,
    publishBlockedByPRLoading,
    publishBlockedByOpenHostedReview,
    publishBlockedByDetachedHead,
    ahead,
    behind,
    shouldForcePushWithLease,
    pushLabelCount,
    forcePushTitle,
    globalBusy,
    commitDisabledReason,
    canCommit
  }
}
