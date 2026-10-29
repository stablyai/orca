import { isPositiveHostedReviewNumber } from '../../../../../../shared/hosted-review'
import type {
  HostedReviewCreationEligibility,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../../../../../shared/hosted-review'
import type { Worktree } from '../../../../../../shared/worktree/types'

type SourceControlSuppressionWorktree = Pick<
  Worktree,
  | 'linkedPR'
  | 'linkedGitLabMR'
  | 'linkedBitbucketPR'
  | 'linkedAzureDevOpsPR'
  | 'linkedGiteaPR'
  | 'suppressedGitHubPR'
>

export type SourceControlSuppressedGitHubPRState = {
  number: number
  status: 'matched' | 'pending'
}

export function resolveSourceControlSuppressedGitHubPRState({
  worktree,
  isFolder,
  provider,
  hasMatchingSuppressedPR,
  hostedReview,
  hostedReviewCreation,
  isHostedReviewCreationLoading,
  hostedReviewCreationRequestFailed
}: {
  worktree: SourceControlSuppressionWorktree | null
  isFolder: boolean
  provider: HostedReviewProvider
  hasMatchingSuppressedPR: boolean
  hostedReview: HostedReviewInfo | null
  hostedReviewCreation: HostedReviewCreationEligibility | null
  isHostedReviewCreationLoading: boolean
  hostedReviewCreationRequestFailed: boolean
}): SourceControlSuppressedGitHubPRState | null {
  if (
    !worktree ||
    isFolder ||
    provider !== 'github' ||
    worktree.linkedPR !== null ||
    worktree.linkedGitLabMR !== null ||
    worktree.linkedBitbucketPR !== null ||
    worktree.linkedAzureDevOpsPR !== null ||
    worktree.linkedGiteaPR !== null ||
    !isPositiveHostedReviewNumber(worktree.suppressedGitHubPR)
  ) {
    return null
  }
  const number = worktree.suppressedGitHubPR
  if (
    hasMatchingSuppressedPR ||
    (hostedReviewCreation?.blockedReason === 'existing_review' &&
      hostedReviewCreation.review?.number === number)
  ) {
    return { number, status: 'matched' }
  }
  if (hostedReview !== null) {
    return null
  }
  if (
    hostedReviewCreationRequestFailed ||
    hostedReviewCreation?.reviewLookupOutcome === 'unavailable'
  ) {
    return null
  }
  if (isHostedReviewCreationLoading) {
    return { number, status: 'pending' }
  }
  if (
    hostedReviewCreation?.reviewLookupOutcome === 'found' ||
    hostedReviewCreation?.reviewLookupOutcome === 'not_found'
  ) {
    return null
  }
  return { number, status: 'pending' }
}
