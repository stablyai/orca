import type { HostedReviewInfo } from '../../../../shared/hosted-review'

type LinkedReviewMetadataProvider = 'github' | 'gitlab'

export type WorktreeCardPrDisplay =
  | HostedReviewInfo
  | {
      provider: LinkedReviewMetadataProvider
      number: number
      title: string
      state?: HostedReviewInfo['state']
      url?: string
      status?: HostedReviewInfo['status']
    }

function getLinkedReviewNumber(
  provider: LinkedReviewMetadataProvider,
  linkedPR: number | null,
  linkedGitLabMR: number | null
): number | null {
  if (provider === 'github') {
    return linkedPR
  }
  return linkedGitLabMR
}

function makeLinkedReviewFallback(
  provider: LinkedReviewMetadataProvider,
  number: number,
  review: HostedReviewInfo | null | undefined
): WorktreeCardPrDisplay {
  const label = provider === 'gitlab' ? 'MR' : 'PR'
  return {
    provider,
    number,
    // Why: linked review metadata is persisted before provider details are cached.
    // Keep the row visible on cold first render while the lookup catches up.
    title: review === null ? `${label} details unavailable` : `Loading ${label}...`
  }
}

function hasLinkedReviewMetadataProvider(
  provider: HostedReviewInfo['provider']
): provider is LinkedReviewMetadataProvider {
  return provider === 'github' || provider === 'gitlab'
}

export function getWorktreeCardPrDisplay(
  review: HostedReviewInfo | null | undefined,
  linkedPR: number | null,
  linkedGitLabMR: number | null = null
): WorktreeCardPrDisplay | null {
  if (review) {
    if (!hasLinkedReviewMetadataProvider(review.provider)) {
      return review
    }
    const linkedReviewNumber = getLinkedReviewNumber(review.provider, linkedPR, linkedGitLabMR)
    if (linkedReviewNumber === null) {
      return null
    }
    if (review.number === linkedReviewNumber) {
      return review
    }
    return makeLinkedReviewFallback(review.provider, linkedReviewNumber, undefined)
  }

  if (linkedPR !== null) {
    return makeLinkedReviewFallback('github', linkedPR, review)
  }

  if (linkedGitLabMR !== null) {
    return makeLinkedReviewFallback('gitlab', linkedGitLabMR, review)
  }

  return null
}
