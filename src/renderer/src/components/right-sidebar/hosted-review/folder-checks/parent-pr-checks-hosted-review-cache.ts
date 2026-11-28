import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { isGitHubPRSuppressed } from '../../../../../../shared/worktree/hosted-review/github-pr-suppression'
import {
  getWorktreeCardPrDisplay,
  isCachedMergedBranchPRCurrentForWorktree
} from '@/components/sidebar/workspace-card/review/worktree-card-pr-display'
import type { ParentPrChecksCacheEntry } from './parent-pr-checks-row-types'
import type { Translate } from '@/i18n/use-translate'

export function canUseParentPrChecksHostedReviewCacheEntry(
  worktree: Worktree,
  review: HostedReviewInfo,
  entry: ParentPrChecksCacheEntry<HostedReviewInfo>,
  t?: Translate
): boolean {
  if (review.provider === 'github' && isGitHubPRSuppressed(worktree, review.number)) {
    return false
  }
  // Why: only GitHub proves merged-head containment; other providers follow the child card's rule.
  if (
    review.provider === 'github' &&
    review.state === 'merged' &&
    !isCachedMergedBranchPRCurrentForWorktree(review, worktree)
  ) {
    return false
  }
  const linkedReviewNumber = getLinkedReviewNumberForProvider(worktree, review.provider)
  if (hasLinkedReview(worktree)) {
    return linkedReviewNumber === review.number
  }
  if ((entry.linkedReviewHintKey ?? '') !== '') {
    return false
  }
  const display = getWorktreeCardPrDisplay(
    review,
    worktree.linkedPR,
    worktree.linkedGitLabMR ?? null,
    worktree.linkedBitbucketPR ?? null,
    worktree.linkedAzureDevOpsPR ?? null,
    worktree.linkedGiteaPR ?? null,
    {
      reviewHintKey: entry.linkedReviewHintKey,
      suppressedGitHubPR: worktree.suppressedGitHubPR ?? null
    },
    t
  )
  return display?.provider === review.provider && display.number === review.number
}

function getLinkedReviewNumberForProvider(
  worktree: Worktree,
  provider: HostedReviewInfo['provider']
): number | null {
  switch (provider) {
    case 'github':
      return worktree.linkedPR
    case 'gitlab':
      return worktree.linkedGitLabMR ?? null
    case 'bitbucket':
      return worktree.linkedBitbucketPR ?? null
    case 'azure-devops':
      return worktree.linkedAzureDevOpsPR ?? null
    case 'gitea':
      return worktree.linkedGiteaPR ?? null
    case 'unsupported':
      return null
  }
}

function hasLinkedReview(worktree: Worktree): boolean {
  return (
    worktree.linkedPR != null ||
    worktree.linkedGitLabMR != null ||
    worktree.linkedBitbucketPR != null ||
    worktree.linkedAzureDevOpsPR != null ||
    worktree.linkedGiteaPR != null
  )
}
