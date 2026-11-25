// A macOS .icns bundle holds one icon at several sizes; modern entries are plain PNGs the browser decodes.
import { BOT_AVATAR_SIZE } from '../../../../shared/bot-avatar'
import { readPngDimensions } from '../../../../shared/file-preview/raster-image-dimensions'

const HEADER_BYTES = 8

export function hasIcnsMagic(bytes: Uint8Array): boolean {
  return bytes[0] === 0x69 && bytes[1] === 0x63 && bytes[2] === 0x6e && bytes[3] === 0x73
}

// The smallest entry that covers the crop, else the largest; legacy ARGB and JPEG 2000 entries are skipped.
function fitsAvatarBetter(side: number, bestSide: number): boolean {
  return bestSide >= BOT_AVATAR_SIZE ? side >= BOT_AVATAR_SIZE && side < bestSide : side > bestSide
}

/** The PNG entry to crop a bot picture from, or null for a malformed or PNG-less bundle. */
export function avatarPngFromIcns(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  if (bytes.byteLength < HEADER_BYTES || !hasIcnsMagic(bytes)) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = view.getUint32(4)
  if (end < HEADER_BYTES || end > bytes.byteLength) {
    return null
  }
  let best: Uint8Array<ArrayBuffer> | null = null
  let bestSide = 0
  for (let offset = HEADER_BYTES; offset < end;) {
    const length = end - offset < HEADER_BYTES ? 0 : view.getUint32(offset + 4)
    if (length < HEADER_BYTES || length > end - offset) {
      return null
    }
    const entry = bytes.subarray(offset + HEADER_BYTES, offset + length)
    const size = readPngDimensions(entry)
    const side = size ? Math.min(size.width, size.height) : 0
    if (side > 0 && fitsAvatarBetter(side, bestSide)) {
      best = entry
      bestSide = side
    }
    offset += length
  }
  return best
}
