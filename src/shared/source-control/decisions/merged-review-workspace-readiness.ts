import type { HostedReviewInfo } from '../hosted-review/hosted-review-contracts'

export type MergedReviewWorkspaceReadiness =
  /** HEAD is the merged review's head (or GitHub confirmed it is in the review) and nothing is uncommitted. */
  | { kind: 'safe-to-delete' }
  | { kind: 'uncommitted-changes'; count: number }
  /** Merged, but this checkout's HEAD cannot be matched to the review, so its commits may be elsewhere. */
  | { kind: 'head-unverified' }

/**
 * Whether a workspace whose review merged still holds work. A squash or rebase merge copies commits onto
 * the base with new IDs, so the branch compare keeps listing them; only HEAD identity proves they landed.
 */
export function resolveMergedReviewWorkspaceReadiness(input: {
  review: Pick<HostedReviewInfo, 'state' | 'headSha' | 'confirmedContainedHeadOid'> | null
  headOid: string | null | undefined
  uncommittedCount: number
}): MergedReviewWorkspaceReadiness | null {
  const { review, uncommittedCount } = input
  if (review?.state !== 'merged') {
    return null
  }
  if (uncommittedCount > 0) {
    return { kind: 'uncommitted-changes', count: uncommittedCount }
  }
  return mergedReviewIncludesHead(review, input.headOid)
    ? { kind: 'safe-to-delete' }
    : { kind: 'head-unverified' }
}

/** HEAD is the review's head, or GitHub confirmed the review contains it. */
export function mergedReviewIncludesHead(
  review: Pick<HostedReviewInfo, 'headSha' | 'confirmedContainedHeadOid'>,
  headOid: string | null | undefined
): boolean {
  const head = headOid?.trim().toLowerCase() ?? ''
  const reviewHeads = [review.headSha, review.confirmedContainedHeadOid].map(
    (oid) => oid?.trim().toLowerCase() ?? ''
  )
  return head.length > 0 && reviewHeads.includes(head)
}
