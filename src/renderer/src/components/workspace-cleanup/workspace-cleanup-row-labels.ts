import type { WorkspaceCleanupReviewInfo } from './workspace-cleanup-presentation'
import { getWorkspaceCleanupReviewStateLabel } from './workspace-cleanup-facet-labels'

export function formatCompactActivityLabel(label: string): string {
  return label === 'Just now' ? 'now' : label.replace(/ ago$/, '')
}

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
