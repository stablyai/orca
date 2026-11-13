import type { PRInfo } from '../../../../../shared/github/pull-requests/pull-request-types'
import type { HostedReviewInfo } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { hostedReviewInfoFromGitHubPRInfo as gitHubPRToChecksPanelReview } from '../../../../../shared/source-control/hosted-review/hosted-review-github'
import { isGitHubPRSuppressed } from '../../../../../shared/worktree/hosted-review/github-pr-suppression'

export type ChecksPanelReview = HostedReviewInfo

export type ChecksPanelReviewSelectionInput = {
  hostedReview: HostedReviewInfo | null | undefined
  pr: PRInfo | null | undefined
  linkedPR: number | null
  suppressedGitHubPR: number | null
  linkedGitLabMR: number | null
  linkedBitbucketPR: number | null
  linkedAzureDevOpsPR: number | null
  linkedGiteaPR: number | null
}

/** The GitHub PR the panel may render, request details for and open; null when another rule wins. */
export function selectUsableGitHubPR({
  hostedReview,
  pr,
  linkedPR,
  suppressedGitHubPR,
  linkedGitLabMR,
  linkedBitbucketPR,
  linkedAzureDevOpsPR,
  linkedGiteaPR
}: ChecksPanelReviewSelectionInput): PRInfo | null {
  if (hostedReview?.provider === 'gitlab') {
    return null
  }
  const hasNonGitHubLinkedReview =
    linkedGitLabMR !== null ||
    linkedBitbucketPR !== null ||
    linkedAzureDevOpsPR !== null ||
    linkedGiteaPR !== null
  if (hasNonGitHubLinkedReview || !pr) {
    return null
  }
  if (linkedPR !== null && pr.number !== linkedPR) {
    return null
  }
  if (isGitHubPRSuppressed({ linkedPR, suppressedGitHubPR }, pr.number)) {
    return null
  }
  return pr
}

export function selectChecksPanelReview(
  input: ChecksPanelReviewSelectionInput
): ChecksPanelReview | null {
  if (input.hostedReview?.provider === 'gitlab') {
    return input.hostedReview
  }
  const pr = selectUsableGitHubPR(input)
  return pr ? gitHubPRToChecksPanelReview(pr) : null
}
