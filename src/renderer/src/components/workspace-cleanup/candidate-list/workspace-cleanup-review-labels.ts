import type { WorkspaceCleanupReviewInfo } from '../candidate-evidence/workspace-cleanup-review-lookup'
import { getWorkspaceCleanupReviewStateLabel } from '../browse/workspace-cleanup-facet-labels'

export function getReviewTooltip(reviewInfo: WorkspaceCleanupReviewInfo): string {
  return [reviewInfo.label, getReviewStateSrText(reviewInfo)].filter(Boolean).join(' · ')
}

/** Text equivalent for the state color on pills that render the number visibly. */
export function getReviewStateSrText(reviewInfo: WorkspaceCleanupReviewInfo): string {
  if (!reviewInfo.state) {
    return ''
  }
  return [getWorkspaceCleanupReviewStateLabel(reviewInfo.state), reviewInfo.title]
    .filter(Boolean)
    .join(' · ')
}
