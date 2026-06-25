import { describe, expect, it } from 'vitest'
import {
  clampMarkupScale,
  dataUrlByteLength,
  markupCanvasSize,
  MARKUP_DOWNSCALE_STEPS,
  MARKUP_JPEG_QUALITIES
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
})

describe('dataUrlByteLength', () => {
  it('decodes the base64 payload size', () => {
    // "hi" -> base64 "aGk=" (1 pad char) -> 2 bytes
    expect(dataUrlByteLength('data:image/png;base64,aGk=')).toBe(2)
    // "man" -> "bWFu" (no padding) -> 3 bytes
    expect(dataUrlByteLength('data:image/png;base64,bWFu')).toBe(3)
  })

  it('returns 0 for a malformed data url', () => {
    expect(dataUrlByteLength('not-a-data-url')).toBe(0)
  })
})

describe('compose budget plans', () => {
  it('tries full size first, then shrinks', () => {
    expect(MARKUP_DOWNSCALE_STEPS[0]).toBe(1)
    expect([...MARKUP_DOWNSCALE_STEPS]).toEqual([...MARKUP_DOWNSCALE_STEPS].sort((a, b) => b - a))
  })

  it('has descending jpeg qualities as a final fallback', () => {
    expect([...MARKUP_JPEG_QUALITIES]).toEqual([...MARKUP_JPEG_QUALITIES].sort((a, b) => b - a))
    expect(MARKUP_JPEG_QUALITIES.every((q) => q > 0 && q <= 1)).toBe(true)
  })
})
