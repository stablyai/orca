import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { HostedReviewInfo } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { hostedReviewInfoFromGitHubPRInfo as gitHubPRToChecksPanelReview } from '../../../../../shared/source-control/hosted-review/hosted-review-github'
import { isGitHubPRSuppressed } from '../../../../../shared/worktree/github-pr-suppression'

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

export function selectChecksPanelReview({
  hostedReview,
  pr,
  linkedPR,
  suppressedGitHubPR,
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
  if (pr && linkedPR !== null && pr.number !== linkedPR) {
    return null
  }
  if (pr && isGitHubPRSuppressed({ linkedPR, suppressedGitHubPR }, pr.number)) {
    return null
  }
  return pr ? gitHubPRToChecksPanelReview(pr) : null
}
