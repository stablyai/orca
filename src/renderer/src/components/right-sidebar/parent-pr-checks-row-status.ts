import type { CheckStatus } from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { translate } from '@/i18n/i18n'
import type {
  ParentPrChecksGroupKey,
  ParentPrChecksRefreshOutcome,
  ParentPrChecksRowStatus
} from './parent-pr-checks-row-types'

export function classifyParentPrChecksRowStatus({
  isUnavailable,
  review,
  hasCacheEntry,
  outcome,
  hasFallbackReview
}: {
  isUnavailable: boolean
  review: HostedReviewInfo | null | undefined
  hasCacheEntry: boolean
  outcome: ParentPrChecksRefreshOutcome | undefined
  hasFallbackReview: boolean
}): ParentPrChecksRowStatus {
  if (isUnavailable) {
    return 'unsupported'
  }
  if (outcome?.kind === 'loading') {
    return review ? classifyKnownReviewStatus(review) : 'loading'
  }
  if (review) {
    return classifyKnownReviewStatus(review)
  }
  if (outcome?.kind === 'error') {
    return 'refreshError'
  }
  if (hasFallbackReview) {
    return 'linkedDetailsUnavailable'
  }
  if (outcome?.kind === 'unavailable') {
    return 'unavailable'
  }
  if (outcome?.kind === 'no-review') {
    return 'noReview'
  }
  return hasCacheEntry ? 'notFetched' : 'notFetched'
}

export function classifyKnownReviewStatus(review: HostedReviewInfo): ParentPrChecksRowStatus {
  if (review.provider === 'unsupported') {
    return 'unsupported'
  }
  if (review.mergeable === 'CONFLICTING') {
    return 'conflict'
  }
  if (review.state === 'merged') {
    return 'merged'
  }
  if (review.state === 'closed') {
    return 'closed'
  }
  if (review.state === 'draft') {
    return 'draft'
  }
  if (review.status === 'failure') {
    return 'failing'
  }
  if (review.status === 'pending') {
    return 'pending'
  }
  if (review.status === 'success') {
    return 'success'
  }
  return 'neutral'
}

export function groupForRowStatus(status: ParentPrChecksRowStatus): ParentPrChecksGroupKey {
  switch (status) {
    case 'failing':
    case 'conflict':
    case 'closed':
    case 'linkedDetailsUnavailable':
    case 'refreshError':
      return 'needsAttention'
    case 'pending':
      return 'pending'
    case 'merged':
      return 'merged'
    case 'success':
      return 'passing'
    case 'draft':
    case 'neutral':
      return 'draftOrNoChecks'
    case 'noReview':
      return 'noPr'
    case 'notFetched':
    case 'loading':
    case 'unsupported':
    case 'unavailable':
      return 'unavailable'
  }
}

export function getRowCheckTone(
  status: ParentPrChecksRowStatus,
  review: HostedReviewInfo | null | undefined
): CheckStatus {
  if (
    ['failing', 'conflict', 'closed', 'linkedDetailsUnavailable', 'refreshError'].includes(status)
  ) {
    return 'failure'
  }
  if (status === 'pending' || status === 'loading') {
    return 'pending'
  }
  if (status === 'success' || status === 'merged') {
    return 'success'
  }
  return review?.status ?? 'neutral'
}

export function getRowSummary(
  status: ParentPrChecksRowStatus,
  review: HostedReviewInfo | null | undefined,
  detailNames: readonly string[]
): string {
  if (detailNames.length > 0 && (status === 'failing' || status === 'pending')) {
    return status === 'failing'
      ? translate(
          'auto.components.rightSidebar.parentPrChecks.rowSummary.failingCount',
          '{{value0}} failing',
          { value0: detailNames.length }
        )
      : translate(
          'auto.components.rightSidebar.parentPrChecks.rowSummary.pendingCount',
          '{{value0}} pending',
          { value0: detailNames.length }
        )
  }
  switch (status) {
    case 'failing':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.checksFailing',
        'Checks failing'
      )
    case 'conflict':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.mergeConflicts',
        'Merge conflicts'
      )
    case 'pending':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.checksPending',
        'Checks pending'
      )
    case 'success':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.checksPassing',
        'Checks passing'
      )
    case 'merged':
      return translate('auto.components.rightSidebar.parentPrChecks.rowSummary.merged', 'Merged')
    case 'closed':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.closedWithoutMerge',
        'Closed without merge'
      )
    case 'draft':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.draftReview',
        'Draft review'
      )
    case 'neutral':
      return review
        ? translate(
            'auto.components.rightSidebar.parentPrChecks.rowSummary.noCheckSignal',
            'No check signal'
          )
        : translate(
            'auto.components.rightSidebar.parentPrChecks.rowSummary.reviewUnavailable',
            'Review status unavailable'
          )
    case 'noReview':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.noPrLinked',
        'No PR linked'
      )
    case 'linkedDetailsUnavailable':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.detailsUnavailable',
        'Review details unavailable'
      )
    case 'refreshError':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.refreshFailed',
        'Refresh failed'
      )
    case 'loading':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.checking',
        'Checking review status…'
      )
    case 'notFetched':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.notFetched',
        'Status not fetched yet'
      )
    case 'unavailable':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.reviewUnavailable',
        'Review status unavailable'
      )
    case 'unsupported':
      return translate(
        'auto.components.rightSidebar.parentPrChecks.rowSummary.unavailableWorktree',
        'Unavailable for this worktree'
      )
  }
}
