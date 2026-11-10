import { afterEach, describe, expect, it } from 'vitest'
import {
  getPRAutoRefreshCadence,
  normalizePRAutoRefreshCadence,
  reviewRefreshIntervalMs,
  scaleReviewRefreshInterval,
  setPRAutoRefreshCadence
} from './review-refresh-policy'

describe('review refresh cadence', () => {
  afterEach(() => {
    setPRAutoRefreshCadence('default')
  })

  it('keeps today’s intervals by default', () => {
    expect(reviewRefreshIntervalMs({ state: 'open', selected: true })).toBe(60_000)
    expect(reviewRefreshIntervalMs({ state: 'open', selected: false })).toBe(120_000)
    expect(reviewRefreshIntervalMs({ hasReview: false, selected: false })).toBe(15 * 60_000)
  })

  it('stretches every timed interval for reduced and minimal', () => {
    expect(reviewRefreshIntervalMs({ state: 'open', selected: true }, 'reduced')).toBe(5 * 60_000)
    expect(reviewRefreshIntervalMs({ state: 'open', selected: false }, 'reduced')).toBe(10 * 60_000)
    expect(reviewRefreshIntervalMs({ state: 'open', selected: true }, 'minimal')).toBe(10 * 60_000)
    expect(reviewRefreshIntervalMs({ state: 'open', selected: false }, 'minimal')).toBe(20 * 60_000)
  })

  it('turns every timed interval off, and keeps settled merged reviews stopped', () => {
    expect(reviewRefreshIntervalMs({ state: 'open', selected: true }, 'off')).toBeNull()
    expect(reviewRefreshIntervalMs({ hasReview: false, selected: true }, 'off')).toBeNull()
    expect(
      reviewRefreshIntervalMs({ state: 'merged', checksStatus: 'success' }, 'reduced')
    ).toBeNull()
    expect(scaleReviewRefreshInterval(null, 'minimal')).toBeNull()
  })

  it('follows the process cadence when no cadence is passed', () => {
    setPRAutoRefreshCadence('minimal')
    expect(getPRAutoRefreshCadence()).toBe('minimal')
    expect(reviewRefreshIntervalMs({ state: 'open', selected: true })).toBe(10 * 60_000)
  })

  it('treats unknown or missing values as default', () => {
    expect(normalizePRAutoRefreshCadence(undefined)).toBe('default')
    expect(normalizePRAutoRefreshCadence('sometimes')).toBe('default')
    setPRAutoRefreshCadence(42)
    expect(getPRAutoRefreshCadence()).toBe('default')
  })
})
