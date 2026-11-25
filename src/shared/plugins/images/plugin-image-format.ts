/**
 * Reads an image's format and size from its header only. Why never decode: plugin images come
 * from strangers, and the checks that matter for trust (format, pixel bounds, animation, bytes)
 * are all in the first few chunks, so a decompression bomb is refused before any decoder runs.
 */

export type PluginImageFormat = 'png' | 'jpeg' | 'webp'

export const PLUGIN_IMAGE_MIME: Record<PluginImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

/** Absolute bounds the host enforces for any plugin image, before per-kind rules. */
export const PLUGIN_IMAGE_MAX_SIDE = 4096

export type PluginImageInfo = { format: PluginImageFormat; width: number; height: number }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

function uint16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)
}

function readPng(bytes: Uint8Array): PluginImageInfo | string {
  if (ascii(bytes, 12, 4) !== 'IHDR') {
    return 'PNG has no header chunk'
  }
  // Why scan chunks: APNG marks animation with an acTL chunk before the first image data.
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = uint32be(bytes, offset)
    const type = ascii(bytes, offset + 4, 4)
    if (type === 'acTL') {
      return 'animated images are not allowed'
    }
    if (type === 'IDAT' || type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  return { format: 'png', width: uint32be(bytes, 16), height: uint32be(bytes, 20) }
}

function readJpeg(bytes: Uint8Array): PluginImageInfo | string {
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) {
      return 'JPEG markers are malformed'
    }
    const marker = bytes[offset + 1] ?? 0
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        format: 'jpeg',
        height: uint16be(bytes, offset + 5),
        width: uint16be(bytes, offset + 7)
      }
    }
    offset += 2 + uint16be(bytes, offset + 2)
  }
  return 'JPEG has no frame header'
}

function readWebp(bytes: Uint8Array): PluginImageInfo | string {
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    const flags = bytes[20] ?? 0
    if (flags & 0x02) {
      return 'animated images are not allowed'
    }
    return { format: 'webp', width: uint24le(bytes, 24) + 1, height: uint24le(bytes, 27) + 1 }
  }
  if (chunk === 'VP8 ') {
    return {
      format: 'webp',
      width: uint16le(bytes, 26) & 0x3fff,
      height: uint16le(bytes, 28) & 0x3fff
    }
  }
  if (chunk === 'VP8L') {
    const b0 = bytes[21] ?? 0
    const b1 = bytes[22] ?? 0
    const b2 = bytes[23] ?? 0
    const b3 = bytes[24] ?? 0
    return {
      format: 'webp',
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    }
  }
  return 'WebP has no image chunk'
}

/** Format and size of a static PNG, JPEG or WebP; an error message for anything else. */
export function readPluginImageHeader(bytes: Uint8Array): PluginImageInfo | string {
  let info: PluginImageInfo | string
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    info = readPng(bytes)
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    info = readJpeg(bytes)
  } else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    info = readWebp(bytes)
  } else {
    return 'must be a PNG, JPEG or WebP image'
  }
  if (typeof info === 'string') {
    return info
  }
  if (info.width < 1 || info.height < 1) {
    return 'image has no size'
  }
  if (info.width > PLUGIN_IMAGE_MAX_SIDE || info.height > PLUGIN_IMAGE_MAX_SIDE) {
    return `image is larger than ${PLUGIN_IMAGE_MAX_SIDE}×${PLUGIN_IMAGE_MAX_SIDE}`
  }
  return info
}
