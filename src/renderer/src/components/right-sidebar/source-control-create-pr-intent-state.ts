import type { PrimaryAction } from './source-control-primary-action-types'
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

export function resolveVisibleCreatePrHeaderAction({
  createPrHeaderAction
}: {
  createPrHeaderAction: PrimaryAction | null
}): PrimaryAction | null {
  // Why: keep a stable header anchor; disable Create PR when the branch is not
  // ready instead of hiding it and shifting the toolbar layout.
  return createPrHeaderAction
}
