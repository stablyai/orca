import { describe, expect, it } from 'vitest'
import { formatNotchDuration, formatNotchElapsedSince } from './notch-duration-format'

describe('formatNotchDuration', () => {
  it('shows seconds under a minute', () => {
    expect(formatNotchDuration(12_400)).toBe('12s')
    expect(formatNotchDuration(59_999)).toBe('59s')
  })

  it('shows whole minutes under an hour', () => {
    expect(formatNotchDuration(60_000)).toBe('1m')
    expect(formatNotchDuration(59 * 60_000 + 59_000)).toBe('59m')
  })

  it('pads minutes in the hour form so the column never jitters', () => {
    expect(formatNotchDuration(3_600_000)).toBe('1h 00m')
    expect(formatNotchDuration(3_600_000 + 4 * 60_000)).toBe('1h 04m')
  })

  it('collapses to days past 24 hours', () => {
    expect(formatNotchDuration(24 * 3_600_000)).toBe('1d')
    expect(formatNotchDuration(50 * 3_600_000)).toBe('2d')
  })

  it('never renders a negative duration from clock skew', () => {
    expect(formatNotchDuration(-4_000)).toBe('0s')
  })

  it('treats sub-second and non-finite input as zero', () => {
    expect(formatNotchDuration(400)).toBe('0s')
    expect(formatNotchDuration(Number.NaN)).toBe('0s')
    expect(formatNotchDuration(Number.POSITIVE_INFINITY)).toBe('0s')
  })
})

describe('formatNotchElapsedSince', () => {
  it('measures from the state start', () => {
    expect(formatNotchElapsedSince(1_000, 1_000 + 90_000)).toBe('1m')
  })
})
