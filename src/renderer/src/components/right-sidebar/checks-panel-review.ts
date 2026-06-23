import type { PRInfo } from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../shared/hosted-review-github'

export type ChecksPanelReview = HostedReviewInfo

export function gitHubPRToChecksPanelReview(pr: PRInfo): ChecksPanelReview {
  // Why: the checks panel must not maintain a second GitHub PR metadata mapper;
  // merge-state fields drifting here regressed the right-sidebar action label.
  return hostedReviewInfoFromGitHubPRInfo(pr)
}
