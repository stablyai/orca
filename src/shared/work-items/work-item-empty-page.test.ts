import { describe, expect, it } from 'vitest'
import { resolveEmptyPageOutcome } from './work-item-empty-page'

describe('resolveEmptyPageOutcome', () => {
  const base = { failedCount: 0, errorTypes: [] as const, countedTotalPages: null }

  it('resolves as load-failed when a window 422 coincides with a sibling failure', () => {
    // A sibling failure says nothing about healthy repos’ remaining pages and must outrank a window clamp.
    expect(
      resolveEmptyPageOutcome({
        ...base,
        target: 5,
        failedCount: 1,
        errorTypes: ['validation_error']
      })
    ).toEqual({ reason: 'load-failed', clampTotalPagesTo: null })
    expect(
      resolveEmptyPageOutcome({
        ...base,
        target: 5,
        errorTypes: ['validation_error', 'permission_denied']
      })
    ).toEqual({ reason: 'load-failed', clampTotalPagesTo: null })
  })

  it('withdraws the speculative page on clean empty only while the count is unknown', () => {
    expect(resolveEmptyPageOutcome({ ...base, target: 2 })).toEqual({
      reason: 'end-of-data',
      clampTotalPagesTo: 2
    })
    expect(resolveEmptyPageOutcome({ ...base, target: 2, countedTotalPages: 0 })).toEqual({
      reason: 'end-of-data',
      clampTotalPagesTo: 2
    })
    // PR failures can become clean-empty results; shrinking a real count would silently hide healthy pages.
    expect(resolveEmptyPageOutcome({ ...base, target: 2, countedTotalPages: 34 })).toEqual({
      reason: 'end-of-data',
      clampTotalPagesTo: null
    })
    expect(resolveEmptyPageOutcome({ ...base, target: 0 })).toEqual({
      reason: 'end-of-data',
      clampTotalPagesTo: 1
    })
  })
})
