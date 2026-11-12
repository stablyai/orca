import type {
  HostedReviewCreationBlockedReason,
  HostedReviewCreationEligibility
} from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { hostedReviewCreateFailureMessage } from '../../hosted-review/provider-actions/hosted-review-create-failure-copy'
import type { Translate } from '../../../../i18n/use-translate'

type ClickableBlockedCreateReviewReason = Extract<
  HostedReviewCreationBlockedReason,
  'dirty' | 'default_branch' | 'no_upstream' | 'needs_push' | 'needs_sync' | 'auth_required'
>

export function canClickBlockedCreateReviewReason(
  reason: HostedReviewCreationBlockedReason | undefined
): reason is ClickableBlockedCreateReviewReason {
  // Keep actionable blockers clickable so inline guidance can explain the next step.
  return (
    reason === 'dirty' ||
    reason === 'default_branch' ||
    reason === 'no_upstream' ||
    reason === 'needs_push' ||
    reason === 'needs_sync' ||
    reason === 'auth_required'
  )
}

export function resolveBlockedCreateReviewNoticeMessage(
  eligibility: HostedReviewCreationEligibility | null | undefined,
  t?: Translate
): string | null {
  if (!eligibility || eligibility.canCreate) {
    return null
  }
  const reason = eligibility.blockedReason
  if (eligibility.reviewLookupOutcome === 'unavailable' && reason === null) {
    return hostedReviewCreateFailureMessage(
      'review_lookup_unavailable',
      eligibility.provider,
      undefined,
      undefined,
      t
    )
  }
  if (!canClickBlockedCreateReviewReason(reason)) {
    return null
  }
  return hostedReviewCreateFailureMessage(reason, eligibility.provider, undefined, undefined, t)
}
