import type { PRMergeableState, PRReviewDecision, PRState } from './pull-request-types'

export type GitHubPRAutoMergeAvailabilityInput = {
  state: PRState
  mergeable?: PRMergeableState
  mergeStateStatus?: string | null
  reviewDecision?: PRReviewDecision | null
  autoMergeEnabled?: boolean
  autoMergeAllowed?: boolean | null
  mergeQueueRequired?: boolean | null
}

export function canShowGitHubPRAutoMergeControl(item: GitHubPRAutoMergeAvailabilityInput): boolean {
  if (item.state !== 'open') {
    return false
  }
  if (item.autoMergeEnabled === true) {
    return true
  }
  if (item.mergeable === 'CONFLICTING' || item.mergeStateStatus === 'DIRTY') {
    return false
  }
  if (item.mergeQueueRequired === true) {
    return true
  }
  // Missing merge metadata is not evidence of an unmet branch requirement.
  return (
    item.mergeStateStatus !== 'UNSTABLE' &&
    item.autoMergeAllowed !== false &&
    (item.reviewDecision === 'REVIEW_REQUIRED' ||
      item.reviewDecision === 'CHANGES_REQUESTED' ||
      item.mergeStateStatus === 'BLOCKED' ||
      item.mergeStateStatus === 'BEHIND')
  )
}
