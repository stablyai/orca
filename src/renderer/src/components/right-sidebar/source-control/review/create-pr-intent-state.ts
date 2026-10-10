import type { PrimaryAction } from '../../source-control-primary-action-types'
import { resolveCreateReviewIntentEligibility } from '../../../../../../shared/source-control-create-review-intent'

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
