export type ImageFileSignature = {
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  extension: 'png' | 'jpg' | 'gif' | 'webp'
}

export const IMAGE_SIGNATURE_BYTES = 12

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]

function startsWith(buffer: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  return (
    buffer.length >= offset + bytes.length &&
    bytes.every((byte, index) => buffer[offset + index] === byte)
  )
}

function startsWithAscii(buffer: Uint8Array, text: string, offset = 0): boolean {
  return startsWith(
    buffer,
    Array.from(text, (char) => char.charCodeAt(0)),
    offset
  )
}

// Signature checks identify file types without proving the image decodes.
/** PNG, JPEG, GIF or WebP: the formats agents take inline. */
export function detectImageFileSignature(buffer: Uint8Array): ImageFileSignature | null {
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return { mimeType: 'image/png', extension: 'png' }
  }
  if (startsWith(buffer, JPEG_SIGNATURE)) {
    return { mimeType: 'image/jpeg', extension: 'jpg' }
  }
  if (startsWithAscii(buffer, 'GIF87a') || startsWithAscii(buffer, 'GIF89a')) {
    return { mimeType: 'image/gif', extension: 'gif' }
  }
  if (startsWithAscii(buffer, 'RIFF') && startsWithAscii(buffer, 'WEBP', 8)) {
    return { mimeType: 'image/webp', extension: 'webp' }
  }
  return null
}

export type ImageFileExtension =
  | ImageFileSignature['extension']
  | 'heic'
  | 'heif'
  | 'avif'
  | 'tiff'
  | 'bmp'

const ISO_MEDIA_IMAGE_EXTENSION_BY_BRAND: Readonly<Record<string, ImageFileExtension>> = {
  heic: 'heic',
  heix: 'heic',
  heim: 'heic',
  heis: 'heic',
  hevc: 'heic',
  hevx: 'heic',
  mif1: 'heif',
  msf1: 'heif',
  avif: 'avif',
  avis: 'avif'
}

/** The extension for any image format these bytes are known to be, so a save never names one format as another. */
export function detectImageFileExtension(buffer: Uint8Array): ImageFileExtension | null {
  const inline = detectImageFileSignature(buffer)
  if (inline) {
    return inline.extension
  }
  if (startsWithAscii(buffer, 'ftyp', 4) && buffer.length >= 12) {
    const brand = String.fromCharCode(...buffer.subarray(8, 12))
    return ISO_MEDIA_IMAGE_EXTENSION_BY_BRAND[brand] ?? null
  }
  if (
    startsWith(buffer, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(buffer, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return 'tiff'
  }
  // BMP's reserved header bytes are zero; "BM" alone also starts ordinary text.
  if (startsWithAscii(buffer, 'BM') && startsWith(buffer, [0, 0, 0, 0], 6)) {
    return 'bmp'
  }
  return null
}
