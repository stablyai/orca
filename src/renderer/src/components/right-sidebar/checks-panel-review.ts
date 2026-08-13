import type { PRInfo } from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'

export type ChecksPanelReview = HostedReviewInfo

export type ChecksPanelReviewSelectionInput = {
  hostedReview: HostedReviewInfo | null | undefined
  pr: PRInfo | null | undefined
  linkedGitLabMR: number | null
  linkedBitbucketPR: number | null
  linkedAzureDevOpsPR: number | null
  linkedGiteaPR: number | null
}

export type ChecksPanelBranchRefs = {
  baseRefName?: string
  headRefName?: string
}

// Why: `pr` is GitHub-only cache data, but the active review may be a GitLab MR
// (or other non-GitHub review) sitting next to a stale/populated GitHub PR
// cache. Only surface GitHub branch refs for a GitHub review so a non-GitHub
// review never renders a GitHub head/base branch.
export function selectChecksPanelBranchRefs(
  review: ChecksPanelReview,
  pr: PRInfo | null | undefined
): ChecksPanelBranchRefs {
  const isGitHub = review.provider === 'github'
  return {
    baseRefName: review.baseRefName ?? (isGitHub ? pr?.baseRefName : undefined),
    headRefName: isGitHub ? pr?.headRefName : undefined
  }
}

export function gitHubPRToChecksPanelReview(pr: PRInfo): ChecksPanelReview {
  // Why: the checks panel must not maintain a second GitHub PR metadata mapper;
  // merge-state fields drifting here regressed the right-sidebar action label.
  return hostedReviewInfoFromGitHubPRInfo(pr)
}

export function selectChecksPanelReview({
  hostedReview,
  pr,
  linkedGitLabMR,
  linkedBitbucketPR,
  linkedAzureDevOpsPR,
  linkedGiteaPR
}: ChecksPanelReviewSelectionInput): ChecksPanelReview | null {
  const gitLabHostedReview = hostedReview?.provider === 'gitlab' ? hostedReview : null
  if (gitLabHostedReview) {
    return gitLabHostedReview
  }
  const hasNonGitHubLinkedReview =
    linkedGitLabMR !== null ||
    linkedBitbucketPR !== null ||
    linkedAzureDevOpsPR !== null ||
    linkedGiteaPR !== null
  if (hasNonGitHubLinkedReview) {
    return null
  }
  return pr ? gitHubPRToChecksPanelReview(pr) : null
}
