import type { WorkspaceCleanupReviewInfo } from './workspace-cleanup-presentation'

export function formatCompactActivityLabel(label: string): string {
  return label === 'Just now' ? 'now' : label.replace(/ ago$/, '')
}

export function getReviewTooltip(reviewInfo: WorkspaceCleanupReviewInfo): string {
  return [reviewInfo.label, reviewInfo.state, reviewInfo.title].filter(Boolean).join(' · ')
}
