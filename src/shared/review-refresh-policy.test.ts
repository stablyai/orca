import { describe, expect, it } from 'vitest'
import { REVIEW_REFRESH_COOLDOWN_MS, reviewRefreshIntervalMs } from './review-refresh-policy'

describe('review refresh intervals', () => {
  it.each([
    [{ state: 'open', selected: true }, 60_000],
    [{ state: 'open', selected: false }, 120_000],
    [{ state: 'draft', selected: true }, 60_000],
    [{ state: 'draft' }, 120_000],
    [{ state: 'merged', checksStatus: 'pending' }, 60_000],
    [{ state: 'merged', checksStatus: null }, 60_000],
    [{ state: 'merged' }, 60_000],
    [{ state: 'merged', checksStatus: 'success' }, null],
    [{ state: 'merged', checksStatus: 'failure' }, null],
    [{ state: 'merged', checksStatus: 'neutral' }, null],
    [{ state: 'closed', selected: true }, 900_000],
    [{ state: 'closed' }, 900_000],
    [{ hasReview: false, selected: true }, 60_000],
    [{ hasReview: false }, 900_000],
    [{ state: 'open', checksStatus: 'success' }, 120_000],
    [{ state: 'open', checksStatus: 'failure', selected: true }, 60_000]
  ] as const)('uses %j → %s', (input, expected) => {
    expect(reviewRefreshIntervalMs(input)).toBe(expected)
  })

  it('keeps exposure cooldown separate from periodic refresh cadence', () => {
    expect(REVIEW_REFRESH_COOLDOWN_MS).toBe(10_000)
  })
})
