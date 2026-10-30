import { describe, expect, it } from 'vitest'
import {
  applyEmptyPageClamp,
  resolveEmptyPageOutcome,
  applyWindowPageLimit,
  deriveAdvertisedTotalPages
} from './work-item-empty-page'

describe('resolveEmptyPageOutcome', () => {
  const base = { failedCount: 0, errorTypes: [] as const, countedTotalPages: null }

  it('clamps and reports unreachable when the search window 422 is present', () => {
    expect(
      resolveEmptyPageOutcome({ ...base, target: 33, errorTypes: ['validation_error'] })
    ).toEqual({ reason: 'window-unreachable', clampTotalPagesTo: 33 })
    expect(
      resolveEmptyPageOutcome({
        ...base,
        target: 33,
        errorTypes: ['validation_error'],
        countedTotalPages: 39
      })
    ).toEqual({ reason: 'window-unreachable', clampTotalPagesTo: 33 })
  })

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

  it('reports a failure without clamping for transient or unclassified errors', () => {
    expect(resolveEmptyPageOutcome({ ...base, target: 5, failedCount: 2 })).toEqual({
      reason: 'load-failed',
      clampTotalPagesTo: null
    })
    for (const type of ['permission_denied', 'not_found', 'rate_limited', 'unknown'] as const) {
      expect(resolveEmptyPageOutcome({ ...base, target: 5, errorTypes: [type] })).toEqual({
        reason: 'load-failed',
        clampTotalPagesTo: null
      })
    }
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

describe('applyEmptyPageClamp', () => {
  const clean = { failedCount: 0, errorTypes: [] as const }

  it('keeps a real count that resolved between click and response', () => {
    // The count can resolve during fetch; clamp against committed state rather than the click-time closure.
    expect(applyEmptyPageClamp(33, { ...clean, target: 2 })).toBe(33)
  })

  it('withdraws the speculative page while the count is unknown or failed', () => {
    expect(applyEmptyPageClamp(null, { ...clean, target: 2 })).toBe(2)
    expect(applyEmptyPageClamp(0, { ...clean, target: 2 })).toBe(2)
  })

  it('never touches the count for window or failure outcomes', () => {
    expect(
      applyEmptyPageClamp(39, { target: 33, failedCount: 0, errorTypes: ['validation_error'] })
    ).toBe(39)
    expect(applyEmptyPageClamp(33, { target: 5, failedCount: 2, errorTypes: [] })).toBe(33)
    expect(applyEmptyPageClamp(null, { target: 5, failedCount: 2, errorTypes: [] })).toBe(null)
  })
})

describe('applyWindowPageLimit', () => {
  it('sets, only lowers, and never goes below one page', () => {
    expect(applyWindowPageLimit(null, 33)).toBe(33)
    expect(applyWindowPageLimit(33, 20)).toBe(20)
    expect(applyWindowPageLimit(20, 33)).toBe(20)
    expect(applyWindowPageLimit(null, 0)).toBe(1)
  })
})

describe('deriveAdvertisedTotalPages', () => {
  it('is order-independent: a count landing after a speculative withdrawal wins', () => {
    // A late real count must overwrite speculative end-of-data withdrawal.
    expect(
      deriveAdvertisedTotalPages({
        loadedPages: 1,
        countedTotalPages: 39,
        fallbackTotalPages: 2,
        provenPageLimit: null
      })
    ).toBe(39)
  })

  it('caps a real count with the proven window limit', () => {
    expect(
      deriveAdvertisedTotalPages({
        loadedPages: 3,
        countedTotalPages: 39,
        fallbackTotalPages: 4,
        provenPageLimit: 33
      })
    ).toBe(33)
  })

  it('uses the fallback while the count is unknown/failed, still window-capped', () => {
    expect(
      deriveAdvertisedTotalPages({
        loadedPages: 1,
        countedTotalPages: null,
        fallbackTotalPages: 2,
        provenPageLimit: null
      })
    ).toBe(2)
    expect(
      deriveAdvertisedTotalPages({
        loadedPages: 1,
        countedTotalPages: 0,
        fallbackTotalPages: 5,
        provenPageLimit: 3
      })
    ).toBe(3)
  })

  it('never advertises fewer pages than are loaded', () => {
    expect(
      deriveAdvertisedTotalPages({
        loadedPages: 5,
        countedTotalPages: 2,
        fallbackTotalPages: 2,
        provenPageLimit: 2
      })
    ).toBe(5)
  })
})
