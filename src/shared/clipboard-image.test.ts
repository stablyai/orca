import { describe, expect, it } from 'vitest'
import {
  CLIPBOARD_IMAGE_DOWNSCALE_SAFETY,
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  assertClipboardImageBase64LengthWithinLimit,
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit,
  computeClipboardImageEncodedSizeDownscale,
  computeClipboardImagePixelDownscale
} from './clipboard-image'

describe('clipboard image limits', () => {
  it('accepts image metadata within configured limits', () => {
    expect(() =>
      assertClipboardImageBase64LengthWithinLimit(CLIPBOARD_IMAGE_MAX_BASE64_CHARS)
    ).not.toThrow()
    expect(() =>
      assertClipboardImageByteLengthWithinLimit(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES)
    ).not.toThrow()
    expect(() => assertClipboardImageDimensionsWithinLimit({ height: 1, width: 1 })).not.toThrow()
  })

  it('rejects oversized byte and base64 lengths with metadata-only errors', () => {
    expect(() =>
      assertClipboardImageBase64LengthWithinLimit(CLIPBOARD_IMAGE_MAX_BASE64_CHARS + 1)
    ).toThrow('Clipboard image is too large')
    expect(() =>
      assertClipboardImageByteLengthWithinLimit(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1)
    ).toThrow('Clipboard image is too large')
  })

  it('rejects invalid or oversized image dimensions before pixel allocation', () => {
    expect(() =>
      assertClipboardImageDimensionsWithinLimit({
        height: 1,
        width: CLIPBOARD_IMAGE_MAX_PIXELS + 1
      })
    ).toThrow('Clipboard image is too large')
    expect(() => assertClipboardImageDimensionsWithinLimit({ height: 0, width: 1 })).toThrow(
      'Clipboard image is too large'
    )
    expect(() =>
      assertClipboardImageDimensionsWithinLimit({ height: Number.POSITIVE_INFINITY, width: 1 })
    ).toThrow('Clipboard image is too large')
  })
})

describe('clipboard image downscale targets', () => {
  it('does not propose a pixel downscale when already within budget', () => {
    expect(computeClipboardImagePixelDownscale(100, 100)).toBeNull()
  })

  it('shrinks both edges so pixel count lands under the max with safety margin', () => {
    // 4x over budget → scale sqrt(0.25)*0.85 = 0.425 → 40*0.425=17, 20*0.425=8.5→8
    const overWidth = 40
    const overHeight = 20
    const maxPixels = (overWidth * overHeight) / 4
    expect(computeClipboardImagePixelDownscale(overWidth, overHeight, maxPixels)).toEqual({
      width: 17,
      height: 8
    })
    expect(17 * 8).toBeLessThanOrEqual(maxPixels)
  })

  it('shrinks encoded-size overflow using sqrt(budget/actual)*safety', () => {
    // 400 bytes vs 100 budget → scale sqrt(0.25)*0.85 = 0.425
    expect(computeClipboardImageEncodedSizeDownscale(400, 40, 20, 100)).toEqual({
      width: 17,
      height: 8
    })
    expect(CLIPBOARD_IMAGE_DOWNSCALE_SAFETY).toBe(0.85)
  })

  it('returns null when encoded size already fits or dimensions cannot shrink', () => {
    expect(computeClipboardImageEncodedSizeDownscale(50, 100, 100, 100)).toBeNull()
    expect(computeClipboardImageEncodedSizeDownscale(400, 1, 1, 100)).toBeNull()
    expect(computeClipboardImagePixelDownscale(0, 20)).toBeNull()
  })
})
