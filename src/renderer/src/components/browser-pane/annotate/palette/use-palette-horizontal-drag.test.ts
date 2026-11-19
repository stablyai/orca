import { describe, expect, it } from 'vitest'
import {
  clampPaletteLeft,
  paletteLeftForRatio,
  paletteRatioForLeft,
  snapPaletteRatio
} from './use-palette-horizontal-drag'

describe('annotate palette horizontal placement', () => {
  it('keeps the palette 8px inside both edges of the page', () => {
    expect(paletteLeftForRatio(0, 600, 200)).toBe(8)
    expect(paletteLeftForRatio(1, 600, 200)).toBe(392)
    expect(paletteLeftForRatio(0.5, 600, 200)).toBe(200)
    expect(clampPaletteLeft(-50, 600, 200)).toBe(8)
    expect(clampPaletteLeft(900, 600, 200)).toBe(392)
  })

  it('keeps the same side of the page when the pane resizes', () => {
    const ratio = paletteRatioForLeft(paletteLeftForRatio(0.8, 600, 200), 600, 200)
    expect(ratio).toBeCloseTo(0.8)
    // Same fraction of the free travel in a wider pane.
    expect(paletteLeftForRatio(ratio, 1000, 200)).toBeCloseTo(8 + 784 * 0.8)
  })

  it('centres a palette that has no room to move', () => {
    expect(paletteRatioForLeft(8, 200, 200)).toBe(0.5)
    expect(paletteLeftForRatio(0.9, 200, 200)).toBe(8)
  })

  it('snaps a release near the centre back to the centre', () => {
    expect(snapPaletteRatio(0.52)).toBe(0.5)
    expect(snapPaletteRatio(0.47)).toBe(0.5)
    expect(snapPaletteRatio(0.6)).toBe(0.6)
  })
})
