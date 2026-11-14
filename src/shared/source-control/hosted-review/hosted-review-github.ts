import { projectPRCheckOwner } from '../../github/checks/complete-pr-check-owner'
import type { HostedReviewInfo } from './hosted-review-contracts'
import type { PRInfo } from '../../github/pull-requests/pull-request-types'

export function hostedReviewInfoFromGitHubPRInfo(pr: PRInfo): HostedReviewInfo {
  const review: HostedReviewInfo = {
    provider: 'github',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.checksStatus,
    ...(pr.checksSummary ? { checksSummary: pr.checksSummary } : {}),
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.reviewDecision !== undefined ? { reviewDecision: pr.reviewDecision } : {}),
    ...(pr.autoMergeEnabled !== undefined ? { autoMergeEnabled: pr.autoMergeEnabled } : {}),
    ...(pr.autoMergeAllowed !== undefined ? { autoMergeAllowed: pr.autoMergeAllowed } : {}),
    ...(pr.mergeQueueRequired !== undefined ? { mergeQueueRequired: pr.mergeQueueRequired } : {}),
    ...(pr.mergeStateStatus !== undefined ? { mergeStateStatus: pr.mergeStateStatus } : {}),
    ...(pr.headSha ? { headSha: pr.headSha } : {}),
    ...(pr.prRepo ? { githubRepository: pr.prRepo } : {}),
    ...(pr.confirmedContainedHeadOid
      ? { confirmedContainedHeadOid: pr.confirmedContainedHeadOid }
      : {}),
    ...(pr.conflictSummary ? { conflictSummary: pr.conflictSummary } : {})
  }
  return projectPRCheckOwner(pr, review)
}
