// A marked image the renderer drew for chat notes: a whole PNG within the agents' image budget,
// never trusted as-is.

import { AGENT_IMAGE_MAX_BYTES, AGENT_IMAGE_MAX_LONG_EDGE } from '../../clipboard/clipboard-image'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** Notes images are drawn at most this long on their long edge, the size agents read images at. */
export const GENERATED_NOTE_IMAGE_MAX_EDGE = AGENT_IMAGE_MAX_LONG_EDGE
/** Notes images are encoded within what agents accept for one image. */
export const GENERATED_NOTE_IMAGE_MAX_BYTES = AGENT_IMAGE_MAX_BYTES

/** Bit depths each PNG color type allows. */
const BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16]
}
/** Samples per pixel for each color type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
/** The only critical chunks PNG defines; any other critical chunk can't be decoded. */
const CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND'])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  )
}

export type GeneratedNoteImageLayout = {
  width: number
  height: number
  /** The decoded size of the image data: each row's filter byte and its samples. */
  rawByteLength: number
  /** The image data, in order, still compressed. */
  data: Uint8Array[]
}

/** The PNG's structure when `bytes` is a whole PNG within the notes-image limits; null otherwise.
 *  Every chunk must be complete with a matching CRC: IHDR first, a palette when one is needed, at
 *  least one run of IDAT and IEND last, with nothing after it. */
export function generatedNoteImageLayout(bytes: unknown): GeneratedNoteImageLayout | null {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 8 ||
    bytes.length > GENERATED_NOTE_IMAGE_MAX_BYTES ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  ) {
    return null
  }
  let header: { width: number; height: number; bitDepth: number; colorType: number } | null = null
  let palette = false
  const data: Uint8Array[] = []
  let dataEnded = false
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset)
    const end = offset + 12 + length
    if (length > bytes.length || end > bytes.length) {
      return null
    }
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(bytes, offset + 4, end - 4) !== readUint32(bytes, end - 4)
    ) {
      return null
    }
    const body = bytes.subarray(offset + 8, end - 4)
    const critical = type.charCodeAt(0) < 97
    if (!header && type !== 'IHDR') {
      return null
    }
    if (critical && !CRITICAL.has(type)) {
      return null
    }
    if (type === 'IHDR') {
      if (header || length !== 13) {
        return null
      }
      const width = readUint32(body, 0)
      const height = readUint32(body, 4)
      const [bitDepth, colorType, compression, filter, interlace] = body.subarray(8, 13)
      // A canvas writes no interlaced PNGs; refusing them keeps the decoded size exact.
      if (
        width === 0 ||
        height === 0 ||
        width > GENERATED_NOTE_IMAGE_MAX_EDGE ||
        height > GENERATED_NOTE_IMAGE_MAX_EDGE ||
        !BIT_DEPTHS[colorType]?.includes(bitDepth) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        return null
      }
      header = { width, height, bitDepth, colorType }
    } else if (type === 'PLTE') {
      if (palette || data.length > 0 || length === 0 || length % 3 !== 0) {
        return null
      }
      palette = true
    } else if (type === 'IDAT') {
      // Image data is one unbroken run of IDAT chunks.
      if (dataEnded) {
        return null
      }
      data.push(body)
    } else if (data.length > 0) {
      dataEnded = true
    }
    offset = end
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length) {
        return null
      }
      if (!header || data.length === 0 || (header.colorType === 3 && !palette)) {
        return null
      }
      const rowBytes = Math.ceil((header.width * CHANNELS[header.colorType] * header.bitDepth) / 8)
      return {
        width: header.width,
        height: header.height,
        rawByteLength: header.height * (1 + rowBytes),
        data
      }
    }
  }
  // No IEND: the file was cut off.
  return null
}

/** The image's size when `bytes` is a whole PNG within the notes-image limits; null otherwise. */
export function generatedNoteImageSize(bytes: unknown): { width: number; height: number } | null {
  const layout = generatedNoteImageLayout(bytes)
  return layout ? { width: layout.width, height: layout.height } : null
}
