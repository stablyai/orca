import { describe, expect, it } from 'vitest'
import type { HostedReviewCreationEligibility } from './hosted-review'
import { isHostedReviewCreateEligibilityConfirmable } from './hosted-review-create-confirmation'

function eligibility(
  overrides: Partial<HostedReviewCreationEligibility> = {}
): HostedReviewCreationEligibility {
  return {
    provider: 'github',
    review: null,
    canCreate: true,
    blockedReason: null,
    nextAction: null,
    reviewLookupOutcome: 'not_found',
    ...overrides
  }
}

describe('isHostedReviewCreateEligibilityConfirmable', () => {
  const base = { reviewLookup: 'not_found' as const, hasHardRefreshError: false }

  it('fails closed on every hard-block: null, existing_review, positive, hard error, unavailable', () => {
    expect(isHostedReviewCreateEligibilityConfirmable({ ...base, eligibility: null })).toBe(false)
    expect(
      isHostedReviewCreateEligibilityConfirmable({
        ...base,
        eligibility: eligibility({ canCreate: false, blockedReason: 'existing_review' })
      })
    ).toBe(false)
    expect(
      isHostedReviewCreateEligibilityConfirmable({
        ...base,
        eligibility: eligibility(),
        reviewLookup: 'positive_unresolved'
      })
    ).toBe(false)
    expect(
      isHostedReviewCreateEligibilityConfirmable({
        ...base,
        eligibility: eligibility(),
        hasHardRefreshError: true
      })
    ).toBe(false)
    expect(
      isHostedReviewCreateEligibilityConfirmable({
        ...base,
        eligibility: eligibility({
          blockedReason: 'needs_push',
          reviewLookupOutcome: 'unavailable'
        })
      })
    ).toBe(false)
  })
})
