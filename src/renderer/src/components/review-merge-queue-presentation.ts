import type { ReviewMergeQueueEntry } from '../../../shared/review-merge-queue-entry'
import { translate } from '@/i18n/i18n'

type ReviewMergeQueuePresentation = {
  label: string
  tooltip: string
  /** True when the provider reports the queued review cannot merge. */
  blocked: boolean
}

export function getReviewMergeQueueLabel(entry: ReviewMergeQueueEntry): string {
  return entry.position === null
    ? translate('reviewMergeQueue.label', 'In merge queue')
    : translate('reviewMergeQueue.positionLabel', '#{{position}} in merge queue', {
        position: entry.position
      })
}

function getReviewMergeQueueTooltip(entry: ReviewMergeQueueEntry): string {
  switch (entry.state) {
    case 'QUEUED':
      return translate('reviewMergeQueue.tooltip.queued', 'Waiting in the merge queue')
    case 'AWAITING_CHECKS':
      return translate(
        'reviewMergeQueue.tooltip.awaitingChecks',
        'Merge queue checks are running for this pull request'
      )
    case 'MERGEABLE':
      return translate(
        'reviewMergeQueue.tooltip.mergeable',
        'Merge queue checks passed; this pull request merges when it reaches the front'
      )
    case 'UNMERGEABLE':
      return translate(
        'reviewMergeQueue.tooltip.unmergeable',
        'The merge queue reports this pull request cannot merge'
      )
    case 'LOCKED':
      return translate(
        'reviewMergeQueue.tooltip.locked',
        'The merge queue has locked this pull request while it merges'
      )
    case null:
      return translate(
        'reviewMergeQueue.tooltip.unknown',
        'This pull request is in the merge queue'
      )
  }
}

export function presentReviewMergeQueueEntry(
  entry: ReviewMergeQueueEntry
): ReviewMergeQueuePresentation {
  return {
    label: getReviewMergeQueueLabel(entry),
    tooltip: getReviewMergeQueueTooltip(entry),
    blocked: entry.state === 'UNMERGEABLE'
  }
}
