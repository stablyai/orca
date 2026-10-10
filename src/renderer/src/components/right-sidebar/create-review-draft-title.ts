import { humanizeBranchSlug } from '../../../../shared/branch-name-from-work'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import { normalizeHostedReviewHeadRef } from '../../../../shared/hosted-review-refs'

export function resolveCreateReviewDraftTitle({
  branch,
  eligibilityTitle
}: {
  branch: string
  eligibilityTitle?: string | null
}): string {
  const title = eligibilityTitle?.trim()
  if (title) {
    return title
  }
  const normalizedBranch = normalizeHostedReviewHeadRef(branch)
  const branchLeaf = normalizedBranch.split('/').pop()?.replace(/_/g, '-') ?? ''
  return humanizeBranchSlug(branchLeaf) || normalizedBranch
}

/** The title and body the composer seeds for a branch, before any edit or generation. */
export function resolveCreateReviewSeedText({
  branch,
  eligibility
}: {
  branch: string
  eligibility: Pick<HostedReviewCreationEligibility, 'title' | 'body'> | null
}): { title: string; body: string } {
  return {
    title: resolveCreateReviewDraftTitle({ branch, eligibilityTitle: eligibility?.title }),
    body: eligibility?.body ?? ''
  }
}
