type HostedReviewProviderLike = {
  provider?: string | null
}

type PRCacheEntryLike = {
  data?: unknown
}

/**
 * Flags GitHub-hosted review metadata whose matching PR cache may still be unknown.
 */
export function hasAmbiguousGitHubHostedReviewForChecksPanel(input: {
  hostedReview: HostedReviewProviderLike | null | undefined
  prCacheEntry: PRCacheEntryLike | null | undefined
  prCacheKey: string
}): boolean {
  return (
    input.hostedReview?.provider === 'github' &&
    input.prCacheKey !== '' &&
    input.prCacheEntry?.data == null
  )
}
