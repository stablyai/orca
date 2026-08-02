import { humanizeBranchSlug } from '../../../../shared/branch-name-from-work'
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
