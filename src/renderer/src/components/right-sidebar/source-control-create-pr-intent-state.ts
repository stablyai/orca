import {
  resolveCreateReviewIntentEligibility,
  type CreateReviewIntentEligibility,
  type CreateReviewIntentKind
} from '../../../../shared/source-control-create-review-intent'

// Why: renderer APIs keep PR terminology for compatibility, while shared logic
// uses provider-neutral review terminology for PR/MR hosts.
export type CreatePrIntentKind = CreateReviewIntentKind
export type CreatePrIntentEligibility = CreateReviewIntentEligibility

export const resolveCreatePrIntentEligibility = resolveCreateReviewIntentEligibility
