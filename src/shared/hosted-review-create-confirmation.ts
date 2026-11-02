/** How sure the caller is that a review exists, beyond the host's lookup outcome. */
export type HostedReviewLookupAuthority = 'found' | 'positive_unresolved' | 'not_found' | 'unknown'

/** Desktop and mobile create blockers; unproven review absence fails closed. */
export function isHostedReviewCreateEligibilityConfirmable(input: {
  // Strings, not the closed unions: newer hosts may send reasons this build does not know.
  eligibility: {
    canCreate?: boolean
    blockedReason?: string | null
    reviewLookupOutcome?: string
  } | null
  reviewLookup: HostedReviewLookupAuthority
  hasHardRefreshError: boolean
}): boolean {
  const eligibility = input.eligibility
  if (!eligibility || eligibility.blockedReason === 'existing_review') {
    return false
  }
  if (input.reviewLookup === 'positive_unresolved' || input.hasHardRefreshError) {
    return false
  }
  // Unavailable lookup may hide a real review; block needs_push as well as plain Create.
  if (eligibility.reviewLookupOutcome === 'unavailable') {
    return false
  }
  return eligibility.canCreate === true || eligibility.blockedReason === 'needs_push'
}
