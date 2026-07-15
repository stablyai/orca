import { describe, expect, it } from 'vitest'

import { formatResetCountdown, formatResetDuration } from './rate-limit-reset-format'

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
