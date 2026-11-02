/**
 * A text or binary frame the desktop gzipped and sealed as a binary frame: a 6-byte header (kind,
 * inflated payload kind, little-endian inflated byte length) and one gzip member. Binary carries it
 * without base64's third, and the kind byte keeps it apart from terminal (0x74) and screencast frames.
 */
export const COMPRESSED_FRAMES_CLIENT_CAPABILITY = 'transport.compressed-frames.v1' as const

const COMPRESSED_FRAME_KIND = 0x7a
const HEADER_BYTES = 6
const PAYLOAD_KIND_BYTES = { text: 1, binary: 2 } as const

export type CompressedFramePayloadKind = keyof typeof PAYLOAD_KIND_BYTES

// Why: below this a gzip member's fixed overhead and the inflate call outweigh the saved bytes.
export const COMPRESSED_FRAME_MIN_BYTES = 1024

export function encodeCompressedFrame(args: {
  payloadKind: CompressedFramePayloadKind
  inflatedByteLength: number
  gzipped: Uint8Array
}): Uint8Array {
  const frame = new Uint8Array(HEADER_BYTES + args.gzipped.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint8(0, COMPRESSED_FRAME_KIND)
  view.setUint8(1, PAYLOAD_KIND_BYTES[args.payloadKind])
  view.setUint32(2, args.inflatedByteLength, true)
  frame.set(args.gzipped, HEADER_BYTES)
  return frame
}

/** Null for any other binary frame, so callers pass it through unchanged. */
export function readCompressedFrame(frame: Uint8Array): {
  payloadKind: CompressedFramePayloadKind
  inflatedByteLength: number
  gzipped: Uint8Array
} | null {
  if (frame.byteLength < HEADER_BYTES || frame[0] !== COMPRESSED_FRAME_KIND) {
    return null
  }
  const payloadKind =
    frame[1] === PAYLOAD_KIND_BYTES.text
      ? 'text'
      : frame[1] === PAYLOAD_KIND_BYTES.binary
        ? 'binary'
        : null
  if (!payloadKind) {
    return null
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return {
    payloadKind,
    inflatedByteLength: view.getUint32(2, true),
    gzipped: frame.subarray(HEADER_BYTES)
  }
}
