import { readPngDimensions } from '../../../../shared/file-preview/raster-image-dimensions'

const ICNS_MAGIC = [0x69, 0x63, 0x6e, 0x73]
const PNG_ICNS_SIDES: Readonly<Record<string, number>> = {
  ic04: 16,
  ic05: 32,
  icp4: 16,
  icp5: 32,
  icp6: 48,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 256,
  ic14: 512
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
}

export function hasIcnsMagic(bytes: Uint8Array): boolean {
  return ICNS_MAGIC.every((value, index) => bytes[index] === value)
}

/** The largest PNG representation, bounded by ICNS's 1024 px slots; other encodings are not decoded. */
export function bestIcnsPng(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength < 8 || !hasIcnsMagic(bytes) || uint32(bytes, 4) !== bytes.byteLength) {
    return null
  }
  let best: Uint8Array | null = null
  let bestSide = 0
  for (let offset = 8; offset < bytes.byteLength;) {
    if (bytes.byteLength - offset < 8) {
      return null
    }
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const length = uint32(bytes, offset + 4)
    if (length < 8 || offset + length > bytes.byteLength) {
      return null
    }
    const expectedSide = PNG_ICNS_SIDES[type]
    const png = bytes.subarray(offset + 8, offset + length)
    const size = expectedSide === undefined ? null : readPngDimensions(png)
    if (
      expectedSide !== undefined &&
      size?.width === expectedSide &&
      size.height === expectedSide &&
      expectedSide > bestSide
    ) {
      best = png
      bestSide = expectedSide
    }
    offset += length
  }
  return best
}

export function isIcnsFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.icns')
}

export function isIcnsMimeType(type: string): boolean {
  return type === 'image/icns' || type === 'image/x-icns'
}
