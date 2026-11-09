import { describe, expect, it } from 'vitest'
import {
  computeChecksPanelConfirmedReadiness,
  type ChecksPanelConfirmedReadinessInput
} from './checks-panel-review-creation'

describe('computeChecksPanelConfirmedReadiness', () => {
  const NOW = 1_000_000
  function readiness(
    overrides: Partial<ChecksPanelConfirmedReadinessInput> = {}
  ): ChecksPanelConfirmedReadinessInput {
    return {
      contextKeyMatches: true,
      eligibility: { canCreate: true, blockedReason: null, reviewLookupOutcome: 'not_found' },
      eligibilityCompletedAt: NOW - 1_000,
      eligibilityRequestStartedAt: NOW - 2_000,
      reviewLookup: 'not_found',
      hardErrorObservedAt: undefined,
      gitSnapshotMatches: true,
      now: NOW,
      ...overrides
    }
  }

  it('confirms fresh, matching eligibility', () => {
    expect(computeChecksPanelConfirmedReadiness(readiness())).toEqual({
      confirmed: true,
      needsPush: false
    })
  })

  it('confirms needs_push as the Push & Create path', () => {
    expect(
      computeChecksPanelConfirmedReadiness(
        readiness({
          eligibility: {
            canCreate: false,
            blockedReason: 'needs_push',
            reviewLookupOutcome: 'not_found'
          }
        })
      )
    ).toEqual({ confirmed: true, needsPush: true })
  })

  it('drops confirmed when the context key does not match', () => {
    expect(
      computeChecksPanelConfirmedReadiness(readiness({ contextKeyMatches: false })).confirmed
    ).toBe(false)
  })

  it('drops confirmed on positive unresolved and existing_review', () => {
    expect(
      computeChecksPanelConfirmedReadiness(readiness({ reviewLookup: 'positive_unresolved' }))
        .confirmed
    ).toBe(false)
    expect(
      computeChecksPanelConfirmedReadiness(
        readiness({
          eligibility: {
            canCreate: false,
            blockedReason: 'existing_review',
            reviewLookupOutcome: 'found'
          }
        })
      ).confirmed
    ).toBe(false)
  })

  it('drops confirmed when eligibility is older than 5 minutes', () => {
    expect(
      computeChecksPanelConfirmedReadiness(
        readiness({ eligibilityCompletedAt: NOW - 5 * 60_000 - 1 })
      ).confirmed
    ).toBe(false)
  })

  it('drops confirmed when the git snapshot no longer matches', () => {
    expect(
      computeChecksPanelConfirmedReadiness(readiness({ gitSnapshotMatches: false })).confirmed
    ).toBe(false)
  })

  describe('hard error clearing', () => {
    it('clears when the request started strictly after the error with an accepted outcome', () => {
      expect(
        computeChecksPanelConfirmedReadiness(
          readiness({
            hardErrorObservedAt: NOW - 3_000,
            eligibilityRequestStartedAt: NOW - 2_000,
            eligibility: { canCreate: true, blockedReason: null, reviewLookupOutcome: 'not_found' }
          })
        ).confirmed
      ).toBe(true)
    })

    it('does not clear for an in-flight request that started before the error', () => {
      expect(
        computeChecksPanelConfirmedReadiness(
          readiness({ hardErrorObservedAt: NOW - 1_500, eligibilityRequestStartedAt: NOW - 2_000 })
        ).confirmed
      ).toBe(false)
    })

    it('does not clear on a late unavailable fallback', () => {
      expect(
        computeChecksPanelConfirmedReadiness(
          readiness({
            hardErrorObservedAt: NOW - 3_000,
            eligibilityRequestStartedAt: NOW - 2_000,
            eligibility: {
              canCreate: false,
              blockedReason: 'no_upstream',
              reviewLookupOutcome: 'unavailable'
            }
          })
        ).confirmed
      ).toBe(false)
    })
  })
})
