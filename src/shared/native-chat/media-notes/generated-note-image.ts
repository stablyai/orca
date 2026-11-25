// A marked image the renderer drew for chat notes: a PNG with bounded pixels, never trusted as-is.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** Notes images are drawn at most 2048px on the long edge; this leaves room without allowing huge decodes. */
export const GENERATED_NOTE_IMAGE_MAX_EDGE = 4096

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  )
}

/** Signature, then the whole IHDR chunk: length, type, 13 bytes of data and its CRC. */
const HEADER_LENGTH = 33
/** Bit depths each PNG color type allows. */
const BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16]
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index]
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** The image's size when `bytes` starts as a valid PNG within the edge limit; null otherwise. */
export function generatedNoteImageSize(bytes: unknown): { width: number; height: number } | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_LENGTH) {
    return null
  }
  if (PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    return null
  }
  // The first chunk must be a complete IHDR: length 13, its fields, and a CRC that matches them.
  const ihdr = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (
    readUint32(bytes, 8) !== 13 ||
    ihdr !== 'IHDR' ||
    crc32(bytes, 12, 29) !== readUint32(bytes, 29)
  ) {
    return null
  }
  const width = readUint32(bytes, 16)
  const height = readUint32(bytes, 20)
  const [bitDepth, colorType, compression, filter, interlace] = bytes.subarray(24, 29)
  if (
    width === 0 ||
    height === 0 ||
    width > GENERATED_NOTE_IMAGE_MAX_EDGE ||
    height > GENERATED_NOTE_IMAGE_MAX_EDGE ||
    !BIT_DEPTHS[colorType]?.includes(bitDepth) ||
    compression !== 0 ||
    filter !== 0 ||
    interlace > 1
  ) {
    return null
  }
  return { width, height }
}
