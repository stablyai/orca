import { describe, expect, it } from 'vitest'
import {
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  assertClipboardImageBase64LengthWithinLimit,
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit,
  isClipboardImageTooLargeError
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

  it('classifies only the stable internal oversized-image sentinel', () => {
    expect(isClipboardImageTooLargeError(new Error('Clipboard image is too large'))).toBe(true)
    expect(isClipboardImageTooLargeError(new Error('La imagen es demasiado grande'))).toBe(false)
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
