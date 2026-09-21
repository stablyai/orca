import { describe, expect, it } from 'vitest'
import { formatPaletteSessionAge } from './palette-session-age'

const NOW = 1_000_000_000

describe('formatPaletteSessionAge', () => {
  it('returns undefined when there is no known activity', () => {
    expect(formatPaletteSessionAge(null, NOW)).toBeUndefined()
  })

  it('buckets clock skew (negative delta) as "<1m"', () => {
    expect(formatPaletteSessionAge(NOW + 5_000, NOW)).toBe('<1m')
  })

  it('stays "<1m" just under the one-minute boundary', () => {
    expect(formatPaletteSessionAge(NOW - 59_000, NOW)).toBe('<1m')
  })

  it('switches to minutes at the one-minute boundary', () => {
    expect(formatPaletteSessionAge(NOW - 60_000, NOW)).toBe('1m')
    expect(formatPaletteSessionAge(NOW - 90_000, NOW)).toBe('1m')
  })

  it('stays in minutes just under the one-hour boundary', () => {
    expect(formatPaletteSessionAge(NOW - 59 * 60_000, NOW)).toBe('59m')
  })

  it('switches to hours at the one-hour boundary', () => {
    expect(formatPaletteSessionAge(NOW - 60 * 60_000, NOW)).toBe('1h')
  })

  it('stays in hours just under the two-day boundary', () => {
    expect(formatPaletteSessionAge(NOW - 47 * 60 * 60_000, NOW)).toBe('47h')
  })

  it('switches to days at the two-day boundary', () => {
    expect(formatPaletteSessionAge(NOW - 48 * 60 * 60_000, NOW)).toBe('2d')
    expect(formatPaletteSessionAge(NOW - 72 * 60 * 60_000, NOW)).toBe('3d')
  })
})
