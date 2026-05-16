import type { HostedReviewInfo } from '../../../../shared/hosted-review'

export type WorktreeCardPrDisplay =
  | HostedReviewInfo
  | {
      provider: 'github'
      number: number
      title: string
      state?: HostedReviewInfo['state']
      url?: string
      status?: HostedReviewInfo['status']
    }

export function getWorktreeCardPrDisplay(
  review: HostedReviewInfo | null | undefined,
  linkedPR: number | null
): WorktreeCardPrDisplay | null {
  if (review) {
    return review
  }

  if (linkedPR === null) {
    return null
  }

  return {
    provider: 'github',
    number: linkedPR,
    // Why: linked PR metadata is persisted before GitHub details are cached.
    // Keep the row visible on cold first render while the PR lookup catches up.
    title: review === null ? 'PR details unavailable' : 'Loading PR...'
  }
}
