// Standalone Electron-free protocol; mirror src/main/ssh/remote-exec/remote-frame-protocol.ts.

import {
  FrameDecoder,
  FrameDecoderContinuationError,
  HEADER_LENGTH,
  MAX_MESSAGE_SIZE,
  FRAME_DECODER_MAX_FRAMES_PER_TURN,
  FRAME_DECODER_MAX_BYTES_PER_TURN,
  FRAME_DECODER_MAX_TURN_MS,
  FRAME_DECODER_MAX_RETAINED_BYTES
} from './relay-frame-decoder'

export {
  FrameDecoder,
  FrameDecoderContinuationError,
  HEADER_LENGTH,
  MAX_MESSAGE_SIZE,
  FRAME_DECODER_MAX_FRAMES_PER_TURN,
  FRAME_DECODER_MAX_BYTES_PER_TURN,
  FRAME_DECODER_MAX_TURN_MS,
  FRAME_DECODER_MAX_RETAINED_BYTES
}
export type { DecodedFrame, FrameDecoderOptions } from './relay-frame-decoder'

export const RELAY_VERSION = '0.1.0'
export const RELAY_SENTINEL = `ORCA-RELAY v${RELAY_VERSION} READY\n`

export const MessageType = {
  Regular: 1,
  Handshake: 2,
  KeepAlive: 9
} as const

// Read one handshake before dispatch so stale --connect bridges cannot drive a mismatched daemon.
export type HandshakeMessage =
  | { type: 'orca-relay-handshake'; version: string; endpointCredential?: string }
  // Informational only; bridge/daemon compatibility already requires matching version.
  | { type: 'orca-relay-handshake-ok'; version: string; runtime?: RelayHandshakeRuntime }
  | { type: 'orca-relay-handshake-mismatch'; expected: string; got: string }
  // A distinct exit distinguishes refused credentials from relay crashes; older bridges reject this type before sentinel.
  | { type: 'orca-relay-handshake-credential-mismatch' }

export type RelayHandshakeRuntime = { kind: string; version: string }

export function encodeHandshakeFrame(msg: HandshakeMessage): Buffer {
  const payload = Buffer.from(JSON.stringify(msg), 'utf-8')
  return encodeFrame(MessageType.Handshake, 0, 0, payload)
}

// Validate pre-auth version strings before any reader interpolates hostile JSON into logs.
const HANDSHAKE_STRING_FIELDS: Readonly<Record<HandshakeMessage['type'], readonly string[]>> = {
  'orca-relay-handshake': ['version'],
  'orca-relay-handshake-ok': ['version'],
  'orca-relay-handshake-mismatch': ['expected', 'got'],
  'orca-relay-handshake-credential-mismatch': []
}

// Reject present non-string optional fields while preserving legitimate credential omission.
const HANDSHAKE_OPTIONAL_STRING_FIELDS: Readonly<
  Record<HandshakeMessage['type'], readonly string[]>
> = {
  'orca-relay-handshake': ['endpointCredential'],
  'orca-relay-handshake-ok': [],
  'orca-relay-handshake-mismatch': [],
  'orca-relay-handshake-credential-mismatch': []
}

function isHandshakeType(value: unknown): value is HandshakeMessage['type'] {
  return typeof value === 'string' && Object.hasOwn(HANDSHAKE_STRING_FIELDS, value)
}

export function parseHandshakeMessage(payload: Buffer): HandshakeMessage {
  const parsed: unknown = JSON.parse(payload.toString('utf-8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Handshake payload is not an object')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the typeof/null guard directly above is exactly what makes this an index-able object; every read below still proves its own field.
  const msg = parsed as Record<string, unknown>
  const t = msg.type
  if (!isHandshakeType(t)) {
    // Avoid String(t): hostile peer objects can throw during conversion and mask the refusal.
    throw new Error(`Unknown handshake type: ${typeof t === 'string' ? t : typeof t}`)
  }
  for (const field of HANDSHAKE_STRING_FIELDS[t]) {
    if (typeof msg[field] !== 'string') {
      throw new Error(`Handshake field ${field} is not a string`)
    }
  }
  for (const field of HANDSHAKE_OPTIONAL_STRING_FIELDS[t]) {
    if (msg[field] !== undefined && typeof msg[field] !== 'string') {
      throw new Error(`Handshake field ${field} is not a string`)
    }
  }
  if (t === 'orca-relay-handshake-ok' && msg.runtime !== undefined) {
    const runtime = msg.runtime
    if (
      typeof runtime !== 'object' ||
      runtime === null ||
      !('kind' in runtime) ||
      typeof runtime.kind !== 'string' ||
      !('version' in runtime) ||
      typeof runtime.version !== 'string'
    ) {
      throw new Error('Handshake field runtime is not a {kind, version} object')
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this is the one place the shape is proved: the type is one of the four literals and every field the union declares has been checked to be a string.
  return msg as unknown as HandshakeMessage
}

export const KEEPALIVE_SEND_MS = 5_000
export const TIMEOUT_MS = 20_000

export const STREAM_CHUNK_SIZE = 256 * 1024
export const MAX_CONCURRENT_STREAMS = 16
export const STREAM_ACK_WINDOW_CHUNKS = 4

// Large git results follow as bulk-lane git.responseChunk frames; older relays return plain results.
export type GitResponseStreamMarker = {
  __orcaGitResponseStream: { streamId: number; totalBytes: number; chunkCount: number }
}

export const RelayErrorCode = {
  TooManyStreams: -33006,
  StreamProtocolError: -33007,
  // Fail only the over-capacity request so callers can narrow scope without losing the link.
  ResponseOverCapacity: -33008,
  GitGrepRecordCapacity: -33009,
  MarkdownListingCapacity: -33010,
  DirectoryListingCapacity: -33011
} as const

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

const JSON_RPC_PAYLOAD_BYTES = Symbol('jsonRpcPayloadBytes')

export type PreparedJsonRpcPayload = Readonly<{
  byteLength: number
  [JSON_RPC_PAYLOAD_BYTES]: Buffer
}>

export function encodeFrame(
  type: number,
  id: number,
  ack: number,
  payload: Buffer | Uint8Array
): Buffer {
  const header = Buffer.alloc(HEADER_LENGTH)
  header[0] = type
  header.writeUInt32BE(id, 1)
  header.writeUInt32BE(ack, 5)
  header.writeUInt32BE(payload.length, 9)
  return Buffer.concat([header, payload])
}

export function encodeJsonRpcFrame(msg: JsonRpcMessage, id: number, ack: number): Buffer {
  return encodePreparedJsonRpcFrame(prepareJsonRpcPayload(msg), id, ack)
}

export function prepareJsonRpcPayload(msg: JsonRpcMessage): PreparedJsonRpcPayload {
  const payload = Buffer.from(JSON.stringify(msg), 'utf-8')
  if (payload.length > MAX_MESSAGE_SIZE) {
    throw new Error(`Message too large: ${payload.length} bytes`)
  }
  return Object.freeze({ byteLength: payload.length, [JSON_RPC_PAYLOAD_BYTES]: payload })
}

export function encodePreparedJsonRpcFrame(
  payload: PreparedJsonRpcPayload,
  id: number,
  ack: number
): Buffer {
  return encodeFrame(MessageType.Regular, id, ack, payload[JSON_RPC_PAYLOAD_BYTES])
}

export function encodeKeepAliveFrame(id: number, ack: number): Buffer {
  return encodeFrame(MessageType.KeepAlive, id, ack, Buffer.alloc(0))
}

export function parseJsonRpcMessage(payload: Buffer): JsonRpcMessage {
  const text = payload.toString('utf-8')
  const msg = JSON.parse(text) as JsonRpcMessage
  if (msg.jsonrpc !== '2.0') {
    throw new Error(`Invalid JSON-RPC version: ${String((msg as Record<string, unknown>).jsonrpc)}`)
  }
  return msg
}
