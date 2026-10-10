import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeBase64Prefix, exceedsRasterImagePreviewLimits } from './raster-image-base64-preview'
import type * as RasterImageDimensionsModule from './raster-image-dimensions'
import { readRasterImageDimensions } from './raster-image-dimensions'
import {
  isKnownRasterImageMimeType,
  isRasterImagePreviewDimensions,
  RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES
} from './raster-image-preview-limits'

/** The pre-change verdict: one full-payload decode, then one dimension read. */
function unprobedExceeds(content: string, mimeType: string | undefined): boolean {
  if (!isKnownRasterImageMimeType(mimeType)) {
    return false
  }
  const prefix = referenceDecodeBase64Prefix(content, RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES)
  if (!prefix) {
    return false
  }
  const dimensions = readRasterImageDimensions(prefix)
  return dimensions !== null && !isRasterImagePreviewDimensions(dimensions)
}

// Why a module mock: the byte length handed to the dimension reader is the direct measure of how
// much of the payload the preview check decoded, and it is the only observable difference between
// the early-stopping probe and the full-payload decode it replaces.
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

// ── Reference decoder: the pre-change implementation, verbatim ──────────────────────────────────
const BASE64_PADDING = -2
const INVALID_BASE64 = -1

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) {
    return code - 65
  }
  if (code >= 97 && code <= 122) {
    return code - 71
  }
  if (code >= 48 && code <= 57) {
    return code + 4
  }
  if (code === 43) {
    return 62
  }
  if (code === 47) {
    return 63
  }
  if (code === 61) {
    return BASE64_PADDING
  }
  return INVALID_BASE64
}

function isWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32
}

function referenceWriteQuartet(
  output: Uint8Array,
  offset: number,
  quartet: readonly number[]
): { bytesWritten: number; padded: boolean } | null {
  const [a, b, c, d] = quartet
  if (a === undefined || b === undefined || a < 0 || b < 0) {
    return null
  }
  if (c === BASE64_PADDING) {
    if (d !== BASE64_PADDING) {
      return null
    }
    if (offset < output.length) {
      output[offset] = (a << 2) | (b >> 4)
    }
    return { bytesWritten: Math.min(1, output.length - offset), padded: true }
  }
  if (c === undefined || c < 0) {
    return null
  }
  if (offset < output.length) {
    output[offset] = (a << 2) | (b >> 4)
  }
  if (offset + 1 < output.length) {
    output[offset + 1] = ((b & 15) << 4) | (c >> 2)
  }
  if (d === BASE64_PADDING) {
    return { bytesWritten: Math.min(2, output.length - offset), padded: true }
  }
  if (d === undefined || d < 0) {
    return null
  }
  if (offset + 2 < output.length) {
    output[offset + 2] = ((c & 3) << 6) | d
  }
  return { bytesWritten: Math.min(3, output.length - offset), padded: false }
}

function referenceDecodeBase64Prefix(content: string, maxBytes: number): Uint8Array | null {
  const capacity = Math.min(maxBytes, Math.ceil(content.length / 4) * 3)
  const output = new Uint8Array(capacity)
  const quartet: number[] = []
  let outputLength = 0
  let padded = false

  for (let index = 0; index < content.length && outputLength < capacity; index += 1) {
    const code = content.charCodeAt(index)
    if (isWhitespace(code)) {
      continue
    }
    if (padded) {
      return null
    }
    const value = base64Value(code)
    if (value === INVALID_BASE64) {
      return null
    }
    quartet.push(value)
    if (quartet.length !== 4) {
      continue
    }
    const decoded = referenceWriteQuartet(output, outputLength, quartet)
    if (!decoded) {
      return null
    }
    outputLength += decoded.bytesWritten
    padded = decoded.padded
    quartet.length = 0
  }

  if (!padded && outputLength < capacity && quartet.length > 0) {
    if (quartet.length === 1 || quartet.includes(BASE64_PADDING)) {
      return null
    }
    while (quartet.length < 4) {
      quartet.push(BASE64_PADDING)
    }
    const decoded = referenceWriteQuartet(output, outputLength, quartet)
    if (!decoded) {
      return null
    }
    outputLength += decoded.bytesWritten
  }
  return output.subarray(0, outputLength)
}

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────
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

function gifBytes(width: number, height: number): Buffer {
  const gif = Buffer.alloc(64)
  gif.write('GIF89a', 0, 'ascii')
  gif.writeUInt16LE(width, 6)
  gif.writeUInt16LE(height, 8)
  return gif
}

function webpBytes(width: number, height: number): Buffer {
  const webp = Buffer.alloc(64)
  webp.write('RIFF', 0, 'ascii')
  webp.writeUInt32LE(50, 4)
  webp.write('WEBP', 8, 'ascii')
  webp.write('VP8X', 12, 'ascii')
  webp.writeUInt32LE(10, 16)
  webp.writeUIntLE(width - 1, 24, 3)
  webp.writeUIntLE(height - 1, 27, 3)
  return webp
}

const DECODE_FIXTURES: { label: string; content: string }[] = [
  { label: 'png', content: pngBytes(24, 512, 512).toString('base64') },
  { label: 'png padded once', content: pngBytes(26, 512, 512).toString('base64') },
  { label: 'png padded twice', content: pngBytes(25, 512, 512).toString('base64') },
  { label: 'png 70 KiB', content: pngBytes(70_000, 512, 512).toString('base64') },
  { label: 'jpeg', content: jpegBytes(0, 640, 480).toString('base64') },
  { label: 'jpeg 70 KiB exif', content: jpegBytes(70_000, 4000, 3000).toString('base64') },
  { label: 'gif', content: gifBytes(320, 240).toString('base64') },
  { label: 'webp', content: webpBytes(800, 600).toString('base64') },
  { label: 'empty', content: '' },
  { label: 'one character', content: 'A' },
  { label: 'two characters', content: 'AB' },
  { label: 'three characters', content: 'ABC' },
  { label: 'invalid character', content: 'AB*D' },
  { label: 'invalid tail', content: `${pngBytes(24, 4, 4).toString('base64')}!!!` },
  { label: 'padding mid-payload', content: 'AAAA=AAA' },
  { label: 'lone padding in tail', content: 'AAAAAB=' },
  { label: 'single padding', content: 'AAAAAA==' },
  { label: 'double padding', content: 'AAAAAAA=' },
  { label: 'stray padding after padding', content: 'AAAA====' },
  {
    label: 'line-wrapped png',
    content: pngBytes(70_000, 512, 512)
      .toString('base64')
      .replace(/(.{76})/g, '$1\r\n')
  },
  { label: 'leading and trailing whitespace', content: `\n\t ${'AAAA'} \r\n` },
  { label: 'truncated png header', content: pngBytes(24, 512, 512).toString('base64').slice(0, 18) }
]

const DECODE_CAPS = [
  0,
  1,
  2,
  3,
  4,
  23,
  24,
  25,
  63,
  64,
  65,
  1024,
  RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES
]

describe('decodeBase64Prefix', () => {
  it('decodes byte-for-byte identically to the reference implementation', () => {
    for (const { label, content } of DECODE_FIXTURES) {
      for (const maxBytes of DECODE_CAPS) {
        const expected = referenceDecodeBase64Prefix(content, maxBytes)
        const actual = decodeBase64Prefix(content, maxBytes)
        const detail = `${label} @ maxBytes=${maxBytes}`
        if (expected === null) {
          expect(actual, detail).toBeNull()
          continue
        }
        expect(actual, detail).not.toBeNull()
        expect(Array.from(actual!), detail).toEqual(Array.from(expected))
      }
    }
  })

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
    // The header answers at 64 bytes, but a suppression verdict is only taken from the same
    // full-payload decode the unprobed implementation used, so invalid base64 past the header
    // still demotes the answer to "could not measure".
    expect(dimensionReadLengths).toEqual([64, 70_000])
  })

  it('keeps rendering an over-limit header whose payload is not valid base64', () => {
    const content = `${pngBytes(70_000, 32_769, 1).toString('base64')}!!!`
    expect(exceedsRasterImagePreviewLimits(content, 'image/png')).toBe(false)
  })

  it('agrees with the unprobed implementation on every fixture and mime type', () => {
    const mimeTypes = [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      undefined
    ]
    const fixtures = [
      ...DECODE_FIXTURES,
      { label: 'over-limit png', content: pngBytes(24, 32_769, 1).toString('base64') },
      { label: 'over-limit pixels png', content: pngBytes(24, 8192, 8192).toString('base64') },
      { label: 'over-limit gif', content: gifBytes(65_535, 65_535).toString('base64') },
      { label: 'over-limit jpeg', content: jpegBytes(70_000, 40_000, 40_000).toString('base64') },
      { label: 'over-limit webp', content: webpBytes(40_000, 40_000).toString('base64') }
    ]
    for (const { label, content } of fixtures) {
      for (const mimeType of mimeTypes) {
        expect(exceedsRasterImagePreviewLimits(content, mimeType), `${label} / ${mimeType}`).toBe(
          unprobedExceeds(content, mimeType)
        )
      }
    }
  })
})
