import type { RasterImageDimensions } from './raster-image-dimensions'
import {
  assertRasterImagePreviewWithinLimits,
  isKnownRasterImageMimeType,
  RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES
} from './raster-image-preview-limits'

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

function writeQuartet(
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

function decodeBase64Prefix(content: string, maxBytes: number): Uint8Array | null {
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
    const decoded = writeQuartet(output, outputLength, quartet)
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
    const decoded = writeQuartet(output, outputLength, quartet)
    if (!decoded) {
      return null
    }
    outputLength += decoded.bytesWritten
  }
  return output.subarray(0, outputLength)
}

/** Returns undefined for non-raster MIME types and null for rejected raster bytes. */
export function readRasterImagePreviewDimensionsFromBase64(
  content: string,
  mimeType: string | undefined
): RasterImageDimensions | null | undefined {
  if (!isKnownRasterImageMimeType(mimeType)) {
    return undefined
  }
  const prefix = decodeBase64Prefix(content, RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES)
  if (!prefix) {
    return null
  }
  try {
    return assertRasterImagePreviewWithinLimits(prefix, mimeType) ?? null
  } catch {
    return null
  }
}
