import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetPRAutoRefreshCadencesForTests,
  getPRAutoRefreshCadenceForHost,
  setPRAutoRefreshCadenceForHost,
  subscribePRAutoRefreshCadence,
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

describe('per-host PR auto-refresh cadence', () => {
  afterEach(() => {
    _resetPRAutoRefreshCadencesForTests()
  })

  it('reads local work by the process cadence and an unknown host as default', () => {
    setPRAutoRefreshCadence('off')
    expect(getPRAutoRefreshCadenceForHost(null)).toBe('off')
    // A local "off" must not stop a paired host whose own setting is default.
    expect(getPRAutoRefreshCadenceForHost('env-1')).toBe('default')
    expect(
      reviewRefreshIntervalMs({ selected: true }, getPRAutoRefreshCadenceForHost('env-1'))
    ).toBe(60_000)
  })

  it('keeps each paired host’s own setting and forgets it when asked', () => {
    setPRAutoRefreshCadenceForHost('env-1', 'minimal')
    setPRAutoRefreshCadenceForHost('env-2', 'reduced')
    expect(getPRAutoRefreshCadenceForHost('env-1')).toBe('minimal')
    expect(getPRAutoRefreshCadenceForHost('env-2')).toBe('reduced')
    expect(getPRAutoRefreshCadence()).toBe('default')
    setPRAutoRefreshCadenceForHost('env-1', null)
    expect(getPRAutoRefreshCadenceForHost('env-1')).toBe('default')
  })

  it('notifies subscribers once per actual change, naming the host that changed', () => {
    const seen: (string | null)[] = []
    const unsubscribe = subscribePRAutoRefreshCadence((hostKey) => seen.push(hostKey))
    setPRAutoRefreshCadence('reduced')
    setPRAutoRefreshCadence('reduced')
    setPRAutoRefreshCadenceForHost('env-1', 'off')
    setPRAutoRefreshCadenceForHost('env-1', 'off')
    unsubscribe()
    setPRAutoRefreshCadence('off')
    expect(seen).toEqual([null, 'env-1'])
  })
})

describe('foreground exposure freshness', () => {
  afterEach(() => {
    _resetPRAutoRefreshCadencesForTests()
  })

  it.each(['default', 'reduced', 'minimal', 'off'] as const)(
    'compares a window return against the Default interval when the cadence is %s',
    async (cadence) => {
      const { reviewForegroundFreshnessMs, setPRAutoRefreshCadence } =
        await import('./review-refresh-policy')
      setPRAutoRefreshCadence(cadence)
      expect(reviewForegroundFreshnessMs({ selected: true })).toBe(60_000)
      expect(reviewForegroundFreshnessMs({ selected: false })).toBe(120_000)
      expect(reviewForegroundFreshnessMs({ hasReview: false, selected: false })).toBe(15 * 60_000)
      // Default runs no timer for settled data: Default keeps its cooldown, others wait a minute.
      expect(reviewForegroundFreshnessMs({ state: 'merged', checksStatus: 'success' })).toBe(
        cadence === 'default' ? 10_000 : 60_000
      )
    }
  )
})
