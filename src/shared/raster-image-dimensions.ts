export type RasterImageDimensions = { width: number; height: number }

const JPEG_DIMENSION_SCAN_MAX_BYTES = 1024 * 1024
const JPEG_DIMENSION_SCAN_MAX_MARKERS = 4_096
const ICO_MAX_IMAGES = 1_024
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function hasBytes(bytes: Uint8Array, offset: number, length: number): boolean {
  return offset >= 0 && length >= 0 && offset + length <= bytes.byteLength
}

function matchesBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return (
    hasBytes(bytes, offset, expected.length) &&
    expected.every((value, index) => bytes[offset + index] === value)
  )
}

function matchesAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (!hasBytes(bytes, offset, expected.length)) {
    return false
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) {
      return false
    }
  }
  return true
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function readUint16Be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset]! << 24) >>> 0) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  )
}

function readInt32Le(bytes: Uint8Array, offset: number): number {
  return readUint32Le(bytes, offset) | 0
}

function positiveDimensions(width: number, height: number): RasterImageDimensions | null {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null
}

function readPngDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  if (
    !matchesBytes(bytes, 0, PNG_SIGNATURE) ||
    !hasBytes(bytes, 8, 16) ||
    readUint32Be(bytes, 8) !== 13 ||
    !matchesAscii(bytes, 12, 'IHDR')
  ) {
    return null
  }
  return positiveDimensions(readUint32Be(bytes, 16), readUint32Be(bytes, 20))
}

function readGifDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  if (
    !hasBytes(bytes, 0, 10) ||
    (!matchesAscii(bytes, 0, 'GIF87a') && !matchesAscii(bytes, 0, 'GIF89a'))
  ) {
    return null
  }
  return positiveDimensions(readUint16Le(bytes, 6), readUint16Le(bytes, 8))
}

function readJpegDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  if (!hasBytes(bytes, 0, 4) || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null
  }
  let offset = 2
  let markersRead = 0
  const scanEnd = Math.min(bytes.byteLength, JPEG_DIMENSION_SCAN_MAX_BYTES)
  while (offset < scanEnd && markersRead < JPEG_DIMENSION_SCAN_MAX_MARKERS) {
    while (offset < scanEnd && bytes[offset] === 0xff) {
      offset += 1
    }
    const marker = bytes[offset]
    offset += 1
    markersRead += 1
    if (marker === undefined || marker === 0x00 || marker === 0xd9 || marker === 0xda) {
      return null
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue
    }
    if (!hasBytes(bytes, offset, 2)) {
      return null
    }
    const segmentLength = readUint16Be(bytes, offset)
    if (segmentLength < 2 || offset + segmentLength > scanEnd) {
      return null
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      return segmentLength >= 7
        ? positiveDimensions(readUint16Be(bytes, offset + 5), readUint16Be(bytes, offset + 3))
        : null
    }
    offset += segmentLength
  }
  return null
}

function readWebpDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  if (
    !hasBytes(bytes, 0, 20) ||
    !matchesAscii(bytes, 0, 'RIFF') ||
    !matchesAscii(bytes, 8, 'WEBP')
  ) {
    return null
  }

  let offset = 12
  while (hasBytes(bytes, offset, 8)) {
    const chunkSize = readUint32Le(bytes, offset + 4)
    const dataOffset = offset + 8
    const dataEnd = dataOffset + chunkSize

    if (matchesAscii(bytes, offset, 'VP8X') && chunkSize >= 10 && hasBytes(bytes, dataOffset, 10)) {
      return positiveDimensions(
        readUint24Le(bytes, dataOffset + 4) + 1,
        readUint24Le(bytes, dataOffset + 7) + 1
      )
    }
    if (
      matchesAscii(bytes, offset, 'VP8L') &&
      chunkSize >= 5 &&
      hasBytes(bytes, dataOffset, 5) &&
      bytes[dataOffset] === 0x2f
    ) {
      const b0 = bytes[dataOffset + 1]!
      const b1 = bytes[dataOffset + 2]!
      const b2 = bytes[dataOffset + 3]!
      const b3 = bytes[dataOffset + 4]!
      return positiveDimensions(
        1 + (((b1 & 0x3f) << 8) | b0),
        1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      )
    }
    if (
      matchesAscii(bytes, offset, 'VP8 ') &&
      chunkSize >= 10 &&
      hasBytes(bytes, dataOffset, 10) &&
      bytes[dataOffset + 3] === 0x9d &&
      bytes[dataOffset + 4] === 0x01 &&
      bytes[dataOffset + 5] === 0x2a
    ) {
      return positiveDimensions(
        readUint16Le(bytes, dataOffset + 6) & 0x3fff,
        readUint16Le(bytes, dataOffset + 8) & 0x3fff
      )
    }
    if (dataEnd > bytes.byteLength) {
      return null
    }
    offset = dataEnd + (chunkSize % 2)
  }
  return null
}

function readDibDimensions(bytes: Uint8Array, offset: number): RasterImageDimensions | null {
  if (!hasBytes(bytes, offset, 12)) {
    return null
  }
  const headerSize = readUint32Le(bytes, offset)
  if (headerSize === 12) {
    return positiveDimensions(readUint16Le(bytes, offset + 4), readUint16Le(bytes, offset + 6))
  }
  if (headerSize < 40 || !hasBytes(bytes, offset, 12)) {
    return null
  }
  return positiveDimensions(
    Math.abs(readInt32Le(bytes, offset + 4)),
    Math.abs(readInt32Le(bytes, offset + 8))
  )
}

function readBmpDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  return matchesAscii(bytes, 0, 'BM') ? readDibDimensions(bytes, 14) : null
}

function readIcoDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  if (!hasBytes(bytes, 0, 6) || readUint16Le(bytes, 0) !== 0 || readUint16Le(bytes, 2) !== 1) {
    return null
  }
  const imageCount = readUint16Le(bytes, 4)
  if (imageCount <= 0 || imageCount > ICO_MAX_IMAGES || !hasBytes(bytes, 6, imageCount * 16)) {
    return null
  }

  let maxWidth = 0
  let maxHeight = 0
  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + index * 16
    const encodedSize = readUint32Le(bytes, entryOffset + 8)
    const imageOffset = readUint32Le(bytes, entryOffset + 12)
    if (encodedSize <= 0 || !hasBytes(bytes, imageOffset, encodedSize)) {
      return null
    }
    const payload = bytes.subarray(imageOffset, imageOffset + encodedSize)
    const embedded = readPngDimensions(payload) ?? readDibDimensions(payload, 0)
    const width = embedded?.width ?? (bytes[entryOffset] === 0 ? 256 : bytes[entryOffset]!)
    const height =
      embedded?.height ?? (bytes[entryOffset + 1] === 0 ? 256 : bytes[entryOffset + 1]!)
    maxWidth = Math.max(maxWidth, width)
    maxHeight = Math.max(maxHeight, height)
  }
  return positiveDimensions(maxWidth, maxHeight)
}

/** Reads encoded raster dimensions without invoking a native or browser image decoder. */
export function readRasterImageDimensions(bytes: Uint8Array): RasterImageDimensions | null {
  return (
    readPngDimensions(bytes) ??
    readGifDimensions(bytes) ??
    readJpegDimensions(bytes) ??
    readWebpDimensions(bytes) ??
    readBmpDimensions(bytes) ??
    readIcoDimensions(bytes)
  )
}
