import type { PRInfo } from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'

export type ChecksPanelReview = Pick<
  HostedReviewInfo,
  'provider' | 'number' | 'title' | 'state' | 'url' | 'status' | 'updatedAt' | 'mergeable'
> &
  Partial<
    Pick<
      HostedReviewInfo,
      | 'headSha'
      | 'conflictSummary'
      | 'reviewDecision'
      | 'autoMergeEnabled'
      | 'mergeQueueRequired'
      | 'mergeStateStatus'
    >
  >

export function gitHubPRToChecksPanelReview(pr: PRInfo): ChecksPanelReview {
  return {
    provider: 'github',
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    status: pr.checksStatus,
    updatedAt: pr.updatedAt,
    mergeable: pr.mergeable,
    ...(pr.headSha ? { headSha: pr.headSha } : {}),
    ...(pr.conflictSummary ? { conflictSummary: pr.conflictSummary } : {}),
    // Why: the merge presenter derives "Approval required"/"Merge when ready"
    // from these. Dropping them here regressed PR #2856 (see PR #4001).
    ...(pr.reviewDecision !== undefined ? { reviewDecision: pr.reviewDecision } : {}),
    ...(pr.autoMergeEnabled !== undefined ? { autoMergeEnabled: pr.autoMergeEnabled } : {}),
    ...(pr.mergeQueueRequired !== undefined ? { mergeQueueRequired: pr.mergeQueueRequired } : {}),
    ...(pr.mergeStateStatus !== undefined ? { mergeStateStatus: pr.mergeStateStatus } : {})
  }
}
