import type { PRMergeableState, PRReviewDecision, PRState } from './types'

export type GitHubPRAutoMergeAvailabilityInput = {
  state: PRState | 'open' | 'closed' | 'merged' | 'draft'
  mergeable?: PRMergeableState
  mergeStateStatus?: string | null
  reviewDecision?: PRReviewDecision | null
  autoMergeEnabled?: boolean
  autoMergeAllowed?: boolean | null
  mergeQueueRequired?: boolean | null
}

function isOpenPR(item: GitHubPRAutoMergeAvailabilityInput): boolean {
  return item.state === 'open'
}

function isConflicting(item: GitHubPRAutoMergeAvailabilityInput): boolean {
  return item.mergeable === 'CONFLICTING' || item.mergeStateStatus === 'DIRTY'
}

function isUnstable(item: GitHubPRAutoMergeAvailabilityInput): boolean {
  return item.mergeStateStatus === 'UNSTABLE'
}

function hasReviewRequirement(item: GitHubPRAutoMergeAvailabilityInput): boolean {
  return item.reviewDecision === 'REVIEW_REQUIRED' || item.reviewDecision === 'CHANGES_REQUESTED'
}

function canMergeImmediately(item: GitHubPRAutoMergeAvailabilityInput): boolean {
  if (item.mergeStateStatus === 'BLOCKED' || item.mergeStateStatus === 'BEHIND') {
    return false
  }
  return item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN'
}

function canRequestWhenReady(item: GitHubPRAutoMergeAvailabilityInput): boolean {
  // Why: GitHub auto-merge waits on unmet requirements; UNSTABLE is rejected
  // by the mutation rather than becoming a waitable auto-merge request.
  if (!isOpenPR(item) || isConflicting(item) || isUnstable(item)) {
    return false
  }
  if (item.mergeQueueRequired === true) {
    return true
  }
  return (
    item.autoMergeAllowed !== false && (hasReviewRequirement(item) || !canMergeImmediately(item))
  )
}

export function canEnableGitHubPRAutoMerge(item: GitHubPRAutoMergeAvailabilityInput): boolean {
  return (
    item.autoMergeEnabled !== true && item.mergeQueueRequired !== true && canRequestWhenReady(item)
  )
}

export function canShowGitHubPRAutoMergeControl(item: GitHubPRAutoMergeAvailabilityInput): boolean {
  // Why: GitHub auto-merge waits for branch requirements, not arbitrary optional CI.
  // Keep already-enabled PRs visible so users can disable the setting.
  return isOpenPR(item) && (item.autoMergeEnabled === true || canRequestWhenReady(item))
}
