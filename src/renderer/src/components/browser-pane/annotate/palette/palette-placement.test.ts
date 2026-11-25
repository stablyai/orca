import { describe, expect, it } from 'vitest'
import {
  clampPaletteOffset,
  paletteKeyMove,
  paletteOffsetForRatio,
  paletteRatioForOffset,
  snapPaletteRatio
} from './palette-placement'

describe('annotate palette placement', () => {
  it('keeps the palette 8px inside both edges of the page on either axis', () => {
    expect(paletteOffsetForRatio(0, 600, 200)).toBe(8)
    expect(paletteOffsetForRatio(1, 600, 200)).toBe(392)
    expect(paletteOffsetForRatio(0.5, 600, 200)).toBe(200)
    expect(clampPaletteOffset(-50, 600, 200)).toBe(8)
    expect(clampPaletteOffset(900, 600, 200)).toBe(392)
    // Vertically: a 38px palette in a 400px page.
    expect(clampPaletteOffset(-50, 400, 38)).toBe(8)
    expect(clampPaletteOffset(900, 400, 38)).toBe(354)
  })

  it('keeps the palette below a find bar that raises the top limit', () => {
    expect(clampPaletteOffset(8, 400, 38, 52)).toBe(52)
    expect(clampPaletteOffset(200, 400, 38, 52)).toBe(200)
    // A page too short to fit under the find bar pins the palette there rather than above it.
    expect(clampPaletteOffset(0, 80, 38, 52)).toBe(52)
  })

  it('keeps the same place on the page when the pane resizes', () => {
    const ratio = paletteRatioForOffset(paletteOffsetForRatio(0.8, 600, 200), 600, 200, 0.5)
    expect(ratio).toBeCloseTo(0.8)
    // Same fraction of the free travel in a larger pane.
    expect(paletteOffsetForRatio(ratio, 1000, 200)).toBeCloseTo(8 + 784 * 0.8)
    // A palette at the bottom stays at the bottom.
    const bottom = paletteRatioForOffset(clampPaletteOffset(900, 400, 38), 400, 38, 0)
    expect(paletteOffsetForRatio(bottom, 700, 38)).toBe(654)
  })

  it('keeps the fallback for an axis with no room to move', () => {
    expect(paletteRatioForOffset(8, 200, 200, 0.5)).toBe(0.5)
    expect(paletteRatioForOffset(8, 40, 38, 0)).toBe(0)
    expect(paletteOffsetForRatio(0.9, 200, 200)).toBe(8)
  })

  it('keeps the saved place on the axis a grip key does not move', () => {
    // A find bar has pushed the shown top below the saved one; a sideways key must not save the pushed top.
    const shown = { x: 0.5, y: 0.2 }
    const saved = { x: 0.5, y: 0 }
    expect(paletteKeyMove('ArrowRight', false, shown, saved, true, true)).toEqual({ x: 0.55, y: 0 })
    expect(paletteKeyMove('End', false, shown, saved, true, true)).toEqual({ x: 1, y: 0 })
    expect(paletteKeyMove('ArrowDown', false, { x: 0.3, y: 0.2 }, saved, true, true)).toEqual({
      x: 0.5,
      y: 0.25
    })
  })

  it('snaps a release near the horizontal centre back to the centre', () => {
    expect(snapPaletteRatio(0.52)).toBe(0.5)
    expect(snapPaletteRatio(0.47)).toBe(0.5)
    expect(snapPaletteRatio(0.6)).toBe(0.6)
  })
})
