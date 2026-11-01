import type { GitConflictOperation } from './git-status-types'
import type { PRInfo } from './github/pull-request-types'
import {
  resolveGitHubPRMergeState,
  type GitHubPRMergeStateKind
} from './github/pull-request-merge-state'
import { resolveGitHubPRStackMergeDecision } from './github/pull-request-stack-merge'
import type { SourceControlCommitAreaPrimaryActionDecision } from './source-control-primary-action-decision-types'

// What the branch's hosted review creation offers once nothing local is left to do.
export type SourceControlNextStepReviewCreation = 'unavailable' | 'create' | 'push_and_create'

export type SourceControlNextStepReview =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'github'; pr: PRInfo; failedChecks: number; pendingChecks: number }

export type SourceControlNextStepInputs = {
  // Desktop's commit-area decision: commit, stage, push, pull, sync or publish.
  local: SourceControlCommitAreaPrimaryActionDecision
  conflictOperation: GitConflictOperation | null | undefined
  hasUnresolvedConflicts: boolean
  /** Staged or stageable work exists, so the commit box has something to commit. */
  hasChangesToCommit: boolean
  reviewCreation: SourceControlNextStepReviewCreation
  review: SourceControlNextStepReview
}

export type SourceControlNextStep =
  | { kind: 'commit' }
  | { kind: 'remote' }
  | { kind: 'complete_merge' }
  | { kind: 'resolve_conflicts'; scope: 'local' | 'review' }
  | { kind: 'create_review'; pushFirst: boolean }
  | { kind: 'fix_checks'; failedChecks: number }
  | { kind: 'merge_when_ready'; mergeState: GitHubPRMergeStateKind; pendingChecks: number }
  | { kind: 'auto_merge_on' }
  | { kind: 'merge' }
  | { kind: 'merge_blocked'; mergeState: GitHubPRMergeStateKind }
  | { kind: 'merged' }
  | { kind: 'none' }

/**
 * The one next action for a branch, in order: local conflicts, the commit box, push/pull,
 * create a review, then the review's own steps toward merge. Desktop's commit area is unchanged;
 * this layers the review steps on top of its decision.
 */
export function resolveSourceControlNextStep(
  inputs: SourceControlNextStepInputs
): SourceControlNextStep {
  const { local, review } = inputs
  if (inputs.hasUnresolvedConflicts) {
    return { kind: 'resolve_conflicts', scope: 'local' }
  }
  if (inputs.conflictOperation === 'merge') {
    return { kind: 'complete_merge' }
  }
  if (inputs.hasChangesToCommit && (local.kind === 'stage' || local.kind === 'commit')) {
    return { kind: 'commit' }
  }
  if (local.kind !== 'commit') {
    const canPushAndCreate =
      (local.kind === 'push' || local.kind === 'publish') &&
      !local.requiresForceWithLease &&
      !local.disabled &&
      review.kind === 'none' &&
      inputs.reviewCreation === 'push_and_create'
    return canPushAndCreate ? { kind: 'create_review', pushFirst: true } : { kind: 'remote' }
  }
  if (review.kind === 'loading') {
    return { kind: 'none' }
  }
  if (review.kind === 'none') {
    return resolveCreateReviewStep(inputs.reviewCreation)
  }
  return resolveReviewStep(review, inputs.reviewCreation)
}

function resolveCreateReviewStep(
  reviewCreation: SourceControlNextStepReviewCreation
): SourceControlNextStep {
  return reviewCreation === 'unavailable'
    ? { kind: 'none' }
    : { kind: 'create_review', pushFirst: reviewCreation === 'push_and_create' }
}

function resolveReviewStep(
  review: Extract<SourceControlNextStepReview, { kind: 'github' }>,
  reviewCreation: SourceControlNextStepReviewCreation
): SourceControlNextStep {
  const { pr } = review
  const mergeState = resolveGitHubPRMergeState(pr)
  if (mergeState.kind === 'merged') {
    return { kind: 'merged' }
  }
  if (mergeState.kind === 'closed') {
    return resolveCreateReviewStep(reviewCreation)
  }
  // Desktop's label ranks review requirements above conflicts; the next step must not.
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
    return { kind: 'resolve_conflicts', scope: 'review' }
  }
  if (review.failedChecks > 0) {
    return { kind: 'fix_checks', failedChecks: review.failedChecks }
  }
  if (pr.autoMergeEnabled === true) {
    return { kind: 'auto_merge_on' }
  }
  // A stack merge lands every PR below this one, so the stack's readiness replaces this PR's.
  const directMergeAvailable = pr.stack
    ? resolveGitHubPRStackMergeDecision({
        stack: pr.stack,
        reviewMergeQueueRequired: pr.mergeQueueRequired,
        stackMergeQueueRequired: undefined,
        directMergeAvailable: mergeState.directMergeAvailable
      }).directMergeAvailable
    : mergeState.directMergeAvailable
  if (directMergeAvailable) {
    return { kind: 'merge' }
  }
  if (mergeState.autoMergeAction !== null && !pr.stack) {
    return {
      kind: 'merge_when_ready',
      mergeState: mergeState.kind,
      pendingChecks: review.pendingChecks
    }
  }
  return { kind: 'merge_blocked', mergeState: mergeState.kind }
}
