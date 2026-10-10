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

// Real 1x1 images that a native decoder accepts, not header-only stubs.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg=='
const JPEG_1X1_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8Afx//2Q=='

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

  it('rejects bytes whose encoding does not match the declared MIME family', () => {
    const png = Buffer.from(PNG_1X1_BASE64, 'base64')
    const jpeg = Buffer.from(JPEG_1X1_BASE64, 'base64')

    expect(assertRasterImagePreviewWithinLimits(png, 'image/png')).toEqual({ width: 1, height: 1 })
    expect(assertRasterImagePreviewWithinLimits(png, 'image/apng')).toEqual({ width: 1, height: 1 })
    expect(assertRasterImagePreviewWithinLimits(jpeg, 'IMAGE/JPEG; charset=binary')).toEqual({
      width: 1,
      height: 1
    })
    expect(assertRasterImagePreviewWithinLimits(jpeg, 'image/pjpeg')).toEqual({
      width: 1,
      height: 1
    })
    expect(() => assertRasterImagePreviewWithinLimits(jpeg, 'image/png')).toThrow(
      INVALID_RASTER_IMAGE_PREVIEW_ERROR
    )
    expect(() => assertRasterImagePreviewWithinLimits(png, 'image/jpeg')).toThrow(
      INVALID_RASTER_IMAGE_PREVIEW_ERROR
    )
    expect(() => assertRasterImagePreviewWithinLimits(png, 'image/x-icon')).toThrow(
      INVALID_RASTER_IMAGE_PREVIEW_ERROR
    )
  })

  it('recognizes supported MIME aliases case-insensitively', () => {
    expect(isKnownRasterImageMimeType('IMAGE/JPEG; charset=binary')).toBe(true)
    expect(isKnownRasterImageMimeType('image/vnd.microsoft.icon')).toBe(true)
    expect(isKnownRasterImageMimeType('image/tiff')).toBe(false)
  })
})
