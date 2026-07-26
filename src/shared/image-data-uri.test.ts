import { describe, expect, it } from 'vitest'
import { buildImageDataUri, validateRasterImageDataUri } from './image-data-uri'

function pngBase64(width = 1, height = 1): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}

describe('buildImageDataUri', () => {
  it('builds a data URI from base64 image bytes', () => {
    const content = pngBase64()
    expect(buildImageDataUri('image/png', content)).toBe(`data:image/png;base64,${content}`)
  })

  it('strips whitespace from line-wrapped base64 payloads', () => {
    const content = pngBase64()
    const wrapped = `${content.slice(0, 8)}\n${content.slice(8, 20)}\t ${content.slice(20)}\r\n`
    expect(buildImageDataUri('image/png', wrapped)).toBe(`data:image/png;base64,${content}`)
  })

  it('returns null for an empty payload', () => {
    expect(buildImageDataUri('image/png', '   \n')).toBeNull()
  })

  it('returns null for a missing mime type', () => {
    expect(buildImageDataUri(undefined, 'bmV3')).toBeNull()
  })

  it('returns null for application/pdf (not an <img> source)', () => {
    expect(buildImageDataUri('application/pdf', 'JVBER')).toBeNull()
  })

  it('returns null for a non-image mime such as application/octet-stream', () => {
    expect(buildImageDataUri('application/octet-stream', 'AAAA')).toBeNull()
  })

  it('rejects malformed and oversized known rasters before native decode', () => {
    expect(buildImageDataUri('image/png', 'bmV3')).toBeNull()
    expect(buildImageDataUri('image/png', pngBase64(32_769, 1))).toBeNull()
    expect(buildImageDataUri('image/png', pngBase64(8192, 8192))).toBeNull()
  })

  it('preserves SVG behavior because vectors do not have encoded raster dimensions', () => {
    expect(buildImageDataUri('image/svg+xml', 'PHN2Zy8+')).toBe(
      'data:image/svg+xml;base64,PHN2Zy8+'
    )
  })
})

describe('validateRasterImageDataUri', () => {
  it('accepts a safe inline raster and rejects an oversized one', () => {
    const safe = `data:image/png;base64,${pngBase64()}`
    expect(validateRasterImageDataUri(safe)).toBe(safe)
    expect(validateRasterImageDataUri(`data:image/png;base64,${pngBase64(32_769, 1)}`)).toBeNull()
  })

  it('preserves non-raster data URIs and rejects non-base64 raster data', () => {
    expect(validateRasterImageDataUri('data:image/svg+xml,%3Csvg/%3E')).toBe(
      'data:image/svg+xml,%3Csvg/%3E'
    )
    expect(validateRasterImageDataUri('data:image/png,not-base64')).toBeNull()
  })
})
