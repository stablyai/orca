import { describe, expect, it } from 'vitest'
import {
  STATUS_BAR_DENSITY_LEVELS,
  pickStatusBarDensityLevel,
  recordStatusBarDensityWidth
} from './status-bar-density'

const TIGHTEST = STATUS_BAR_DENSITY_LEVELS.length - 1

describe('pickStatusBarDensityLevel', () => {
  it('keeps the roomiest level that fits', () => {
    expect(pickStatusBarDensityLevel([700, 600, 500, 400, 300], 800)).toBe(0)
    expect(pickStatusBarDensityLevel([700, 600, 500, 400, 300], 550)).toBe(2)
  })

  it('probes an unmeasured level before settling on a tighter one', () => {
    expect(pickStatusBarDensityLevel([700, undefined, 500], 650)).toBe(1)
    expect(pickStatusBarDensityLevel([], 650)).toBe(0)
  })

  it('falls back to the tightest level when nothing fits', () => {
    expect(pickStatusBarDensityLevel([700, 600, 500, 400, 300], 200)).toBe(TIGHTEST)
  })

  it('tolerates sub-pixel rounding at the boundary', () => {
    expect(pickStatusBarDensityLevel([600.6], 600)).toBe(0)
  })
})

describe('recordStatusBarDensityWidth', () => {
  it('fills in a level without disturbing the others', () => {
    expect(recordStatusBarDensityWidth([700, undefined, 500], 1, 600)).toEqual([700, 600, 500])
  })

  it('forgets other levels when a level re-measures differently', () => {
    // A segment appeared or vanished, so the other levels' widths no longer describe the bar.
    expect(recordStatusBarDensityWidth([700, 600, 500], 1, 640)).toEqual([undefined, 640])
  })

  it('keeps other levels on a sub-pixel re-measure', () => {
    expect(recordStatusBarDensityWidth([700, 600, 500], 1, 600.5)).toEqual([700, 600.5, 500])
  })
})
