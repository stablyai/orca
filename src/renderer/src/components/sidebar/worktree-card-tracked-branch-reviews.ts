import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { CardReviewRow } from './worktree-card-attached-reviews'

/**
 * Converts tracked sibling branches' resolved reviews into card rows.
 *
 * `entries` is aligned index-by-index with `trackedBranches`: each slot holds
 * whatever the hosted-review cache knows for that branch. A branch with no
 * review yet (null/undefined) produces no row — a dead row with nothing to
 * open would only suggest the lookup failed.
 *
 * The worktree's own branch is skipped even if the user tracked it: its review
 * is already the card's primary, and the URL dedupe downstream would drop the
 * duplicate anyway, but skipping avoids fetching the same branch twice.
 */
export function getTrackedBranchReviewRows(
  trackedBranches: readonly string[] | undefined,
  currentBranch: string,
  entries: readonly (HostedReviewInfo | null | undefined)[]
): CardReviewRow[] {
  if (!trackedBranches?.length) {
    return []
  }

  const rows: CardReviewRow[] = []
  trackedBranches.forEach((branch, index) => {
    if (branch === currentBranch) {
      return
    }
    const review = entries[index]
    if (!review?.url || review.provider === 'unsupported') {
      return
    }
    rows.push({
      provider: review.provider,
      number: review.number,
      url: review.url,
      headRef: branch,
      ...(review.baseRefName ? { baseRef: review.baseRefName } : {}),
      ...(review.title ? { title: review.title } : {}),
      state: review.state,
      status: review.status
    })
  })
  return rows
}
