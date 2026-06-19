const BROWSER_SCREENCAST_KIND = 0x62
const BROWSER_SCREENCAST_VERSION = 1
const HEADER_BYTES = 16
const METADATA_KEYS = [
  'offsetTop',
  'pageScaleFactor',
  'deviceWidth',
  'deviceHeight',
  'imageWidth',
  'imageHeight',
  'scrollOffsetX',
  'scrollOffsetY',
  'timestamp'
] as const

export enum BrowserScreencastOpcode {
  Frame = 1
}

export type BrowserScreencastFormat = 'jpeg' | 'png'

export type BrowserScreencastFrameMetadata = {
  offsetTop?: number
  pageScaleFactor?: number
  deviceWidth?: number
  deviceHeight?: number
  imageWidth?: number
  imageHeight?: number
  scrollOffsetX?: number
  scrollOffsetY?: number
  timestamp?: number
}

export type BrowserScreencastFrame = {
  opcode: BrowserScreencastOpcode.Frame
  seq: number
  format: BrowserScreencastFormat
  metadata: BrowserScreencastFrameMetadata
  image: Uint8Array
}

function formatToByte(format: BrowserScreencastFormat): number {
  return format === 'png' ? 2 : 1
}

function byteToFormat(value: number): BrowserScreencastFormat | null {
  if (value === 1) {
    return 'jpeg'
  }
  if (value === 2) {
    return 'png'
  }
  return null
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function decodeFrameMetadata(bytes: Uint8Array): BrowserScreencastFrameMetadata | null {
  const raw = decodeJson(bytes)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const input = raw as Record<string, unknown>
  const metadata: BrowserScreencastFrameMetadata = {}
  for (const key of METADATA_KEYS) {
    const value = input[key]
    if (isFiniteNumber(value)) {
      metadata[key] = value
    }
  }
  return metadata
}

export function encodeBrowserScreencastFrame(frame: BrowserScreencastFrame): Uint8Array {
  const metadata = encodeJson(frame.metadata)
  const out = new Uint8Array(HEADER_BYTES + metadata.byteLength + frame.image.byteLength)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint8(0, BROWSER_SCREENCAST_KIND)
  view.setUint8(1, BROWSER_SCREENCAST_VERSION)
  view.setUint8(2, frame.opcode)
  view.setUint8(3, formatToByte(frame.format))
  view.setUint32(4, Math.max(0, Math.floor(frame.seq)) >>> 0, true)
  view.setUint32(8, metadata.byteLength, true)
  view.setUint32(12, 0, true)
  out.set(metadata, HEADER_BYTES)
  out.set(frame.image, HEADER_BYTES + metadata.byteLength)
  return out
}

export function decodeBrowserScreencastFrame(bytes: Uint8Array): BrowserScreencastFrame | null {
  if (bytes.byteLength < HEADER_BYTES) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    view.getUint8(0) !== BROWSER_SCREENCAST_KIND ||
    view.getUint8(1) !== BROWSER_SCREENCAST_VERSION
  ) {
    return null
  }
  if (view.getUint8(2) !== BrowserScreencastOpcode.Frame) {
    return null
  }
  const format = byteToFormat(view.getUint8(3))
  if (!format) {
    return null
  }
  const seq = view.getUint32(4, true)
  const metadataLength = view.getUint32(8, true)
  if (view.getUint32(12, true) !== 0) {
    return null
  }
  const payloadStart = HEADER_BYTES
  const imageStart = payloadStart + metadataLength
  if (imageStart > bytes.byteLength) {
    return null
  }
  const metadata = decodeFrameMetadata(bytes.subarray(payloadStart, imageStart))
  if (!metadata) {
    return null
  }
  return {
    opcode: BrowserScreencastOpcode.Frame,
    seq,
    format,
    metadata,
    image: bytes.subarray(imageStart)
  }
}
