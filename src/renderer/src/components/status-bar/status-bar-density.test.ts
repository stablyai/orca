import { describe, expect, it } from 'vitest'
import {
  STATUS_BAR_DENSITY_LEVELS,
  pickStatusBarDensityLevel,
  recordStatusBarDensityWidth
} from './status-bar-density'

const TIGHTEST = STATUS_BAR_DENSITY_LEVELS.length - 1
const w = (natural: number, fit = natural) => ({ natural, fit })

describe('STATUS_BAR_DENSITY_LEVELS', () => {
  it('collapses usage into "+N" before right-side segments lose their labels', () => {
    const firstCollapse = STATUS_BAR_DENSITY_LEVELS.findIndex((level) => level.collapseUsage)
    const firstIconOnly = STATUS_BAR_DENSITY_LEVELS.findIndex((level) => level.segmentsIconOnly)
    expect(firstCollapse).toBeGreaterThan(-1)
    expect(firstCollapse).toBeLessThan(firstIconOnly)
  })
})

describe('pickStatusBarDensityLevel', () => {
  it('keeps the roomiest level that fits', () => {
    expect(pickStatusBarDensityLevel([w(700), w(600), w(500), w(400), w(300)], 800)).toBe(0)
    expect(pickStatusBarDensityLevel([w(700), w(600), w(500), w(400), w(300)], 550)).toBe(2)
  })

  it('fits a collapsing level by its collapsed width, not its natural width', () => {
    // Level 3 would need 500 with every chip, but 380 with calm chips folded into "+N".
    expect(pickStatusBarDensityLevel([w(700), w(600), w(500), w(500, 380), w(300)], 400)).toBe(3)
  })

  it('probes an unmeasured level before settling on a tighter one', () => {
    expect(pickStatusBarDensityLevel([w(700), undefined, w(500)], 650)).toBe(1)
    expect(pickStatusBarDensityLevel([], 650)).toBe(0)
  })

  it('falls back to the tightest level when nothing fits', () => {
    expect(pickStatusBarDensityLevel([w(700), w(600), w(500), w(400), w(300)], 200)).toBe(TIGHTEST)
  })

  it('tolerates sub-pixel rounding at the boundary', () => {
    expect(pickStatusBarDensityLevel([w(600.6)], 600)).toBe(0)
  })
})

describe('recordStatusBarDensityWidth', () => {
  it('fills in a level without disturbing the others', () => {
    expect(recordStatusBarDensityWidth([w(700), undefined, w(500)], 1, w(600))).toEqual([
      w(700),
      w(600),
      w(500)
    ])
  })

  it('forgets other levels when a level re-measures differently', () => {
    // A segment appeared or vanished, so the other levels' widths no longer describe the bar.
    expect(recordStatusBarDensityWidth([w(700), w(600), w(500)], 1, w(640))).toEqual([
      undefined,
      w(640)
    ])
  })

  it('keeps other levels when only the collapsed width moves', () => {
    // Collapsing different chips changes the fit width, never the natural one.
    expect(recordStatusBarDensityWidth([w(700), w(600, 450)], 1, w(600, 430))).toEqual([
      w(700),
      w(600, 430)
    ])
  })

  it('keeps other levels on a sub-pixel re-measure', () => {
    expect(recordStatusBarDensityWidth([w(700), w(600), w(500)], 1, w(600.5))).toEqual([
      w(700),
      w(600.5),
      w(500)
    ])
  })
})
