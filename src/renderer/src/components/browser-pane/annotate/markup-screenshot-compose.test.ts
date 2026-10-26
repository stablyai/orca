import { describe, expect, it } from 'vitest'
import {
  clampMarkupScale,
  dataUrlByteLength,
  effectiveMarkupScale,
  markupCanvasSize
} from './markup-screenshot-compose'

describe('clampMarkupScale', () => {
  it('keeps sane scales and clamps to [1, 4]', () => {
    expect(clampMarkupScale(2)).toBe(2)
    expect(clampMarkupScale(0.5)).toBe(1)
    expect(clampMarkupScale(10)).toBe(4)
  })

  it('guards against non-finite / non-positive values', () => {
    expect(clampMarkupScale(0)).toBe(1)
    expect(clampMarkupScale(-3)).toBe(1)
    expect(clampMarkupScale(Number.NaN)).toBe(1)
  })
})

describe('markupCanvasSize', () => {
  it('sizes the output to the content box times the (clamped) scale', () => {
    expect(markupCanvasSize(800, 600, 2)).toEqual({ width: 1600, height: 1200 })
    expect(markupCanvasSize(800, 600, 0.5)).toEqual({ width: 800, height: 600 })
  })

  it('keeps the composite within the pixel budget (never over)', () => {
    // A large HiDPI pane: 4000×3000 CSS × dpr 2 = 48M px > the ~33.55M (32×1024×1024) ceiling.
    const maxPixels = 32 * 1024 * 1024
    const size = markupCanvasSize(4000, 3000, 2, maxPixels)
    expect(size.width * size.height).toBeLessThanOrEqual(maxPixels)
    expect(size.width / size.height).toBeCloseTo(4000 / 3000, 3)
  })
})

describe('effectiveMarkupScale', () => {
  it('returns the clamped scale when the composite fits the pixel budget', () => {
    expect(effectiveMarkupScale(800, 600, 2, 32 * 1024 * 1024)).toBe(2)
  })

  it('reduces the scale so area stays within the pixel budget', () => {
    const scale = effectiveMarkupScale(4000, 3000, 2, 32 * 1024 * 1024)
    expect(scale).toBeLessThan(2)
    expect(4000 * scale * (3000 * scale)).toBeLessThanOrEqual(32 * 1024 * 1024 + 1)
  })

  it('defaults to the clamped scale with no pixel budget', () => {
    expect(effectiveMarkupScale(3840, 2160, 2)).toBe(2)
  })
})

describe('dataUrlByteLength', () => {
  it('decodes the base64 payload size', () => {
    expect(dataUrlByteLength('data:image/png;base64,aGk=')).toBe(2)
    expect(dataUrlByteLength('data:image/png;base64,bWFu')).toBe(3)
  })

  it('returns 0 for a malformed data url', () => {
    expect(dataUrlByteLength('not-a-data-url')).toBe(0)
  })
})
