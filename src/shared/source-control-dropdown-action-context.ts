// Derive shared branch/review facts once so dropdown labels and disabled states cannot disagree.

import type { SourceControlPrimaryActionDecisionInputs } from './source-control-primary-action-decision-types'
import { canSubmitCommit, resolveCommitDisabledReason } from './source-control-commit-eligibility'
import type { GitConflictOperation } from './git-status-types'
import { shouldForcePushWithLeaseForUpstream } from './git-upstream-status'
import type { DropdownActionInputs } from './source-control-dropdown-item-types'

export type DropdownActionContext = {
  upstreamStatus: SourceControlPrimaryActionDecisionInputs['upstreamStatus']
  hostedReviewCreation: SourceControlPrimaryActionDecisionInputs['hostedReviewCreation']
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
  // Undefined means loading, not unpublished; treating it as false could republish and clobber the upstream.
  const upstreamLoading = upstreamStatus === undefined
  const hasUpstream = upstreamStatus?.hasUpstream ?? false
  const hasOpenHostedReview = prState === 'open' || prState === 'draft'
  const canPushUntrackedHostedReview =
    !hasUpstream &&
    hasOpenHostedReview &&
    hasCurrentBranch &&
    branchCommitsAhead !== 0 &&
    canPushLinkedReviewWithoutUpstream
  // Only missing review heads block Push; zero ahead commits still means the target is known.
  const pushBlockedByOpenHostedReviewTarget =
    !hasUpstream && hasOpenHostedReview && !canPushLinkedReviewWithoutUpstream
  const publishBlockedByMergedPR = !hasUpstream && prState === 'merged'
  const publishBlockedByPRLoading = !hasUpstream && !!isPRStateLoading
  const publishBlockedByOpenHostedReview = !hasUpstream && hasOpenHostedReview
  const publishBlockedByDetachedHead = !hasUpstream && !hasCurrentBranch
  const ahead = upstreamStatus?.ahead ?? 0
  const behind = upstreamStatus?.behind ?? 0
  const shouldForcePushWithLease = shouldForcePushWithLeaseForUpstream(upstreamStatus)
  // Use branch-compare counts; upstream ahead can be zero while loading or inflated by patch-equivalent rewrites.
  const pushLabelCount =
    branchCommitsAhead !== undefined &&
    branchCommitsAhead > 0 &&
    (shouldForcePushWithLease || !hasUpstream)
      ? branchCommitsAhead
      : ahead

  // Lock all rows during in-flight work to prevent queued actions against stale snapshots.
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
    globalBusy,
    commitDisabledReason,
    canCommit
  }
}
