import { readRasterImageDimensions } from './raster-image-dimensions'
import {
  isKnownRasterImageMimeType,
  isRasterImagePreviewDimensions,
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

/** `quartetLength` under 4 is a final short group; the missing slots decode as `=` padding. */
function writeQuartet(
  output: Uint8Array,
  offset: number,
  quartet: readonly number[],
  quartetLength: number
): { bytesWritten: number; padded: boolean } | null {
  // Index reads avoid iterator setup/four next calls per input quartet.
  const a = quartet[0]
  const b = quartet[1]
  const c = quartetLength > 2 ? quartet[2] : BASE64_PADDING
  const d = quartetLength > 3 ? quartet[3] : BASE64_PADDING
  if (quartetLength < 2 || a === undefined || b === undefined || a < 0 || b < 0) {
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

/** Exported so the decode can be compared byte-for-byte against a reference implementation. */
export function decodeBase64Prefix(content: string, maxBytes: number): Uint8Array | null {
  const capacity = Math.min(maxBytes, Math.ceil(content.length / 4) * 3)
  const output = new Uint8Array(capacity)
  // Fixed four slots plus a counter, never resized: `quartet.length = 0` deoptimizes the array.
  const quartet = [0, 0, 0, 0]
  let quartetLength = 0
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
    quartet[quartetLength] = value
    quartetLength += 1
    if (quartetLength !== 4) {
      continue
    }
    const decoded = writeQuartet(output, outputLength, quartet, 4)
    if (!decoded) {
      return null
    }
    outputLength += decoded.bytesWritten
    padded = decoded.padded
    quartetLength = 0
  }

  if (!padded && outputLength < capacity && quartetLength > 0) {
    for (let index = 0; index < quartetLength; index += 1) {
      if (quartet[index] === BASE64_PADDING) {
        return null
      }
    }
    const decoded = writeQuartet(output, outputLength, quartet, quartetLength)
    if (!decoded) {
      return null
    }
    outputLength += decoded.bytesWritten
  }
  return output.subarray(0, outputLength)
}

// 64 bytes clears fixed headers/JFIF SOF, measuring ordinary screenshots/icons without decoding the full image.
export const RASTER_IMAGE_HEADER_PROBE_BYTES = 64
// JPEG metadata can push SOF arbitrarily far; geometric growth keeps repeated decoding within ~1.07x of needed header bytes.
export const RASTER_IMAGE_HEADER_PROBE_GROWTH = 16

/** Only confidently oversized images suppress previews; unknown/truncated headers mean unmeasurable, not invalid images. */
export function exceedsRasterImagePreviewLimits(
  content: string,
  mimeType: string | undefined
): boolean {
  if (!isKnownRasterImageMimeType(mimeType)) {
    return false
  }
  let probeBytes = RASTER_IMAGE_HEADER_PROBE_BYTES
  for (;;) {
    const prefix = decodeBase64Prefix(content, probeBytes)
    // Prefix failures also fail the full decoder because both use the same state machine.
    if (!prefix) {
      return false
    }
    // Shorter than asked for means the payload ran out, so a wider probe cannot add bytes.
    const exhausted =
      prefix.byteLength < probeBytes || probeBytes >= RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES
    const dimensions = readRasterImageDimensions(prefix)
    if (dimensions !== null) {
      const withinLimits = isRasterImagePreviewDimensions(dimensions)
      if (withinLimits || exhausted) {
        return !withinLimits
      }
      // Revalidate the full payload before suppression so invalid trailing base64 preserves the old unmeasurable verdict.
      probeBytes = RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES
      continue
    }
    if (exhausted) {
      return false
    }
    probeBytes = Math.min(
      probeBytes * RASTER_IMAGE_HEADER_PROBE_GROWTH,
      RASTER_IMAGE_PREVIEW_HEADER_MAX_BYTES
    )
  }
}
