import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeBase64Prefix, exceedsRasterImagePreviewLimits } from './raster-image-base64-preview'
import type * as RasterImageDimensionsModule from './raster-image-dimensions'
import { RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES } from './raster-image-preview-limits'

// Observe decoded bytes handed to dimension reading; output equivalence alone cannot detect wasted full-payload decoding.
const { dimensionReadLengths } = vi.hoisted(() => ({ dimensionReadLengths: [] as number[] }))

vi.mock('./raster-image-dimensions', async (importOriginal) => {
  const actual = await importOriginal<typeof RasterImageDimensionsModule>()
  return {
    ...actual,
    readRasterImageDimensions: (bytes: Uint8Array) => {
      dimensionReadLengths.push(bytes.byteLength)
      return actual.readRasterImageDimensions(bytes)
    }
  }
})

function pngBytes(totalBytes: number, width: number, height: number): Buffer {
  const bytes = Buffer.alloc(Math.max(totalBytes, 24))
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  for (let index = 24; index < bytes.length; index += 1) {
    bytes[index] = (index * 31 + 7) & 0xff
  }
  return bytes
}

/** SOI, `metadataBytes` of APP2 padding (real cameras chain many segments), then SOF0. */
function jpegBytes(
  metadataBytes: number,
  width: number,
  height: number,
  trailingBytes = 4096
): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]
  for (let written = 0; written < metadataBytes;) {
    const size = Math.min(65_533, metadataBytes - written)
    const header = Buffer.alloc(4)
    header.writeUInt16BE(0xffe2)
    header.writeUInt16BE(size + 2, 2)
    parts.push(header, Buffer.alloc(size))
    written += size
  }
  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(0xffc0)
  sof.writeUInt16BE(8, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  parts.push(sof, Buffer.alloc(trailingBytes))
  return Buffer.concat(parts)
}

describe('decodeBase64Prefix', () => {
  it('stops at the byte cap instead of decoding the whole payload', () => {
    const content = pngBytes(70_000, 512, 512).toString('base64')
    expect(decodeBase64Prefix(content, 32)?.byteLength).toBe(32)
  })
})

describe('exceedsRasterImagePreviewLimits', () => {
  beforeEach(() => {
    dimensionReadLengths.length = 0
  })

  it('measures a large image from its first bytes, not its last', () => {
    // Regression guard: before the probe this decoded all 5 MiB before reading 24 bytes of IHDR.
    const content = pngBytes(5 * 1024 * 1024, 512, 512).toString('base64')
    expect(exceedsRasterImagePreviewLimits(content, 'image/png')).toBe(false)
    expect(dimensionReadLengths).toEqual([64])
  })

  it('widens the probe until a JPEG SOF past its metadata is reachable', () => {
    const content = jpegBytes(70_000, 4000, 3000, 3_000_000).toString('base64')
    expect(exceedsRasterImagePreviewLimits(content, 'image/jpeg')).toBe(false)
    expect(dimensionReadLengths).toEqual([64, 1024, 16_384, 262_144])
    // Far below the ~3 MiB the payload decodes to, and below the 8 MiB fallback cap.
    expect(dimensionReadLengths.at(-1)!).toBeLessThan(RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES)
  })

  it('re-reads the whole payload before suppressing an over-limit image', () => {
    const content = pngBytes(70_000, 32_769, 1).toString('base64')
    expect(exceedsRasterImagePreviewLimits(content, 'image/png')).toBe(true)
    // Before suppression, validate the full payload: later invalid base64 must still mean unmeasurable, not oversized.
    expect(dimensionReadLengths).toEqual([64, 70_000])
  })

  it('keeps rendering an over-limit header whose payload is not valid base64', () => {
    const content = `${pngBytes(70_000, 32_769, 1).toString('base64')}!!!`
    expect(exceedsRasterImagePreviewLimits(content, 'image/png')).toBe(false)
  })
})
