import { describe, expect, it } from 'vitest'

import {
  formatResetCountdown,
  formatResetDuration,
  getResetCountdownNextTickDelay
} from './rate-limit-reset-format'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('formatResetDuration', () => {
  it('returns "now" for non-positive deltas', () => {
    expect(formatResetDuration(0)).toBe('now')
    expect(formatResetDuration(-1)).toBe('now')
  })

  it('floors to whole units and drops zero remainders', () => {
    expect(formatResetDuration(47 * MIN)).toBe('47m')
    expect(formatResetDuration(3 * HOUR + 54 * MIN)).toBe('3h 54m')
    expect(formatResetDuration(2 * HOUR)).toBe('2h')
    expect(formatResetDuration(6 * DAY + 7 * HOUR)).toBe('6d 7h')
    expect(formatResetDuration(7 * DAY)).toBe('7d')
  })
})

describe('formatResetCountdown', () => {
  it('prefixes the duration or reports "Resets now"', () => {
    expect(formatResetCountdown(0)).toBe('Resets now')
    expect(formatResetCountdown(3 * HOUR + 54 * MIN)).toBe('Resets in 3h 54m')
    expect(formatResetCountdown(6 * DAY + 7 * HOUR)).toBe('Resets in 6d 7h')
  })
})

describe('getResetCountdownNextTickDelay', () => {
  const now = 1_000_000_000

  it('returns null when there is nothing to count down', () => {
    expect(getResetCountdownNextTickDelay(now, [])).toBeNull()
    // Past / non-finite resets never schedule a tick.
    expect(getResetCountdownNextTickDelay(now, [now - MIN, now])).toBeNull()
    expect(getResetCountdownNextTickDelay(now, [Number.NaN, Number.POSITIVE_INFINITY])).toBeNull()
  })

  it('wakes just after the next minute boundary while under a day out', () => {
    // 90m 30s away -> next label flip is at the 90m mark, i.e. after 30s.
    expect(getResetCountdownNextTickDelay(now, [now + 90 * MIN + 30_000])).toBe(30_000 + 1)
  })

  it('ticks on hour boundaries when a reset is a day or more away', () => {
    // 2d 3h 15m away -> hour-granular labels, next flip after 15m.
    expect(getResetCountdownNextTickDelay(now, [now + 2 * DAY + 3 * HOUR + 15 * MIN])).toBe(
      15 * MIN + 1
    )
  })

  it('returns the soonest delay across multiple resets', () => {
    const soon = now + 5 * MIN + 10_000 // 10s to next flip
    const later = now + 42 * MIN + 40_000 // 40s to next flip
    expect(getResetCountdownNextTickDelay(now, [later, soon])).toBe(10_000 + 1)
  })
})
