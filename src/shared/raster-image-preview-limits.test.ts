import { describe, expect, it } from 'vitest'
import {
  INVALID_RASTER_IMAGE_PREVIEW_ERROR,
  MAX_RASTER_IMAGE_PREVIEW_DIMENSION_PX,
  RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR,
  assertRasterImagePreviewWithinLimits,
  isKnownRasterImageMimeType
} from './raster-image-preview-limits'

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

describe('raster image preview limits', () => {
  it('accepts ordinary 8K images and returns their dimensions', () => {
    expect(assertRasterImagePreviewWithinLimits(pngHeader(7680, 4320), 'image/png')).toEqual({
      width: 7680,
      height: 4320
    })
  })

  it('rejects oversized edges and total pixel counts before decode', () => {
    expect(() =>
      assertRasterImagePreviewWithinLimits(
        pngHeader(MAX_RASTER_IMAGE_PREVIEW_DIMENSION_PX + 1, 1),
        'image/png'
      )
    ).toThrow(RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR)
    expect(() => assertRasterImagePreviewWithinLimits(pngHeader(8192, 8192), 'image/png')).toThrow(
      RASTER_IMAGE_PREVIEW_TOO_LARGE_ERROR
    )
  })

  it('rejects invalid known raster bytes but leaves SVG and PDF unchanged', () => {
    expect(() => assertRasterImagePreviewWithinLimits(new Uint8Array([1]), 'image/gif')).toThrow(
      INVALID_RASTER_IMAGE_PREVIEW_ERROR
    )
    expect(
      assertRasterImagePreviewWithinLimits(new Uint8Array([1]), 'image/svg+xml')
    ).toBeUndefined()
    expect(
      assertRasterImagePreviewWithinLimits(new Uint8Array([1]), 'application/pdf')
    ).toBeUndefined()
  })

  it('recognizes supported MIME aliases case-insensitively', () => {
    expect(isKnownRasterImageMimeType('IMAGE/JPEG; charset=binary')).toBe(true)
    expect(isKnownRasterImageMimeType('image/vnd.microsoft.icon')).toBe(true)
    expect(isKnownRasterImageMimeType('image/tiff')).toBe(false)
  })
})
