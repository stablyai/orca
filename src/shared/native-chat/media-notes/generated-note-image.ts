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

/** The image's size when `bytes` is a PNG within the edge limit; null otherwise. */
export function generatedNoteImageSize(bytes: unknown): { width: number; height: number } | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24) {
    return null
  }
  if (PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    return null
  }
  // The first chunk must be IHDR: length 13, then width and height.
  const ihdr = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
  if (readUint32(bytes, 8) !== 13 || ihdr !== 'IHDR') {
    return null
  }
  const width = readUint32(bytes, 16)
  const height = readUint32(bytes, 20)
  if (
    width === 0 ||
    height === 0 ||
    width > GENERATED_NOTE_IMAGE_MAX_EDGE ||
    height > GENERATED_NOTE_IMAGE_MAX_EDGE
  ) {
    return null
  }
  return { width, height }
}
