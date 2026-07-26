import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { PRInfo, Worktree } from '../../../../shared/types'
import {
  getWorktreeCardPrDisplay,
  isCachedMergedBranchPRCurrentForWorktree
} from '@/components/sidebar/worktree-card-pr-display'
import type { ParentPrChecksCacheEntry } from './parent-pr-checks-row-types'

export function canUseParentPrChecksHostedReviewCacheEntry(
  worktree: Worktree,
  review: HostedReviewInfo,
  entry: ParentPrChecksCacheEntry<HostedReviewInfo>
): boolean {
  if (review.state === 'merged' && !mergedReviewMatchesHead(review, worktree)) {
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
    { reviewHintKey: entry.linkedReviewHintKey }
  )
  return display?.provider === review.provider && display.number === review.number
}

function mergedReviewMatchesHead(review: HostedReviewInfo, worktree: Worktree): boolean {
  return isCachedMergedBranchPRCurrentForWorktree(
    {
      number: review.number,
      title: review.title,
      state: review.state,
      url: review.url,
      checksStatus: review.status,
      updatedAt: review.updatedAt,
      mergeable: review.mergeable,
      ...(review.headSha ? { headSha: review.headSha } : {}),
      ...(review.confirmedContainedHeadOid
        ? { confirmedContainedHeadOid: review.confirmedContainedHeadOid }
        : {})
    } satisfies PRInfo,
    worktree
  )
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
