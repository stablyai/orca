import { JIRA_IMAGE_CHUNK_BYTES } from './jira-attachment-image'

const IMAGE_KIND = 0x6a
const IMAGE_VERSION = 1
const HEADER_BYTES = 42
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeJiraImageFrame(
  transferId: string,
  sequence: number,
  bytes: Uint8Array
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(HEADER_BYTES + bytes.byteLength)
  frame[0] = IMAGE_KIND
  frame[1] = IMAGE_VERSION
  new DataView(frame.buffer).setUint32(2, sequence, true)
  frame.set(encoder.encode(transferId), 6)
  frame.set(bytes, HEADER_BYTES)
  return frame
}

export function decodeJiraImageFrame(
  bytes: Uint8Array<ArrayBufferLike>,
  transferId: string
): { sequence: number; bytes: Uint8Array<ArrayBufferLike> } | null {
  if (
    bytes.byteLength < HEADER_BYTES ||
    bytes[0] !== IMAGE_KIND ||
    bytes[1] !== IMAGE_VERSION ||
    decoder.decode(bytes.subarray(6, HEADER_BYTES)) !== transferId
  ) {
    return null
  }
  const payload = bytes.subarray(HEADER_BYTES)
  if (payload.byteLength === 0 || payload.byteLength > JIRA_IMAGE_CHUNK_BYTES) {
    throw new Error('Invalid Jira image chunk size.')
  }
  return {
    sequence: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true),
    bytes: payload
  }
}
