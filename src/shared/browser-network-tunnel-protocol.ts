const BROWSER_NETWORK_TUNNEL_KIND = 0x6e
const BROWSER_NETWORK_TUNNEL_VERSION = 1
const HEADER_BYTES = 16
const MAX_OPEN_HOST_BYTES = 1024
const MAX_CONTROL_PAYLOAD_BYTES = 1024
const MAX_UINT32 = 0xffff_ffff

export const BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES = 64 * 1024
export const BROWSER_NETWORK_TUNNEL_MAX_WINDOW_UPDATE_BYTES = 16 * 1024 * 1024

export enum BrowserNetworkTunnelOpcode {
  Open = 1,
  Opened = 2,
  Data = 3,
  WindowUpdate = 4,
  HalfClose = 5,
  Close = 6,
  Error = 7,
  Ping = 8,
  Pong = 9
}

export type BrowserNetworkTunnelFrame = {
  opcode: BrowserNetworkTunnelOpcode
  tunnelGeneration: number
  streamId: number
  payload: Uint8Array<ArrayBufferLike>
}

export type BrowserNetworkTunnelOpen = {
  host: string
  port: number
}

export function encodeBrowserNetworkTunnelFrame(frame: BrowserNetworkTunnelFrame): Uint8Array {
  validateFrameIdentity(frame)
  validatePayload(frame.opcode, frame.payload)
  const output = new Uint8Array(HEADER_BYTES + frame.payload.byteLength)
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength)
  view.setUint8(0, BROWSER_NETWORK_TUNNEL_KIND)
  view.setUint8(1, BROWSER_NETWORK_TUNNEL_VERSION)
  view.setUint8(2, frame.opcode)
  view.setUint8(3, 0)
  view.setUint32(4, frame.tunnelGeneration, false)
  view.setUint32(8, frame.streamId, false)
  view.setUint32(12, frame.payload.byteLength, false)
  output.set(frame.payload, HEADER_BYTES)
  return output
}

export function decodeBrowserNetworkTunnelFrame(
  bytes: Uint8Array<ArrayBufferLike>
): BrowserNetworkTunnelFrame | null {
  if (bytes.byteLength < HEADER_BYTES) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const opcode = view.getUint8(2)
  const tunnelGeneration = view.getUint32(4, false)
  const streamId = view.getUint32(8, false)
  const payloadLength = view.getUint32(12, false)
  if (
    view.getUint8(0) !== BROWSER_NETWORK_TUNNEL_KIND ||
    view.getUint8(1) !== BROWSER_NETWORK_TUNNEL_VERSION ||
    view.getUint8(3) !== 0 ||
    !isBrowserNetworkTunnelOpcode(opcode) ||
    payloadLength !== bytes.byteLength - HEADER_BYTES
  ) {
    return null
  }
  const payload = bytes.subarray(HEADER_BYTES)
  try {
    validateFrameIdentity({ opcode, tunnelGeneration, streamId, payload })
    validatePayload(opcode, payload)
  } catch {
    return null
  }
  return { opcode, tunnelGeneration, streamId, payload }
}

export function encodeBrowserNetworkTunnelOpen(target: BrowserNetworkTunnelOpen): Uint8Array {
  if (!target.host || target.host.includes('\0')) {
    throw new Error('Browser tunnel host is invalid')
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535) {
    throw new Error('Browser tunnel port is invalid')
  }
  const host = new TextEncoder().encode(target.host)
  if (host.byteLength > MAX_OPEN_HOST_BYTES) {
    throw new Error('Browser tunnel host is too long')
  }
  const output = new Uint8Array(4 + host.byteLength)
  const view = new DataView(output.buffer)
  view.setUint16(0, target.port, false)
  view.setUint16(2, host.byteLength, false)
  output.set(host, 4)
  return output
}

export function decodeBrowserNetworkTunnelOpen(
  payload: Uint8Array<ArrayBufferLike>
): BrowserNetworkTunnelOpen | null {
  if (payload.byteLength < 5) {
    return null
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const port = view.getUint16(0, false)
  const hostLength = view.getUint16(2, false)
  if (
    port === 0 ||
    hostLength === 0 ||
    hostLength > MAX_OPEN_HOST_BYTES ||
    hostLength + 4 !== payload.byteLength
  ) {
    return null
  }
  try {
    const host = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(4))
    if (!host || host.includes('\0')) {
      return null
    }
    return { host, port }
  } catch {
    return null
  }
}

export function encodeBrowserNetworkTunnelWindowUpdate(bytes: number): Uint8Array {
  if (
    !Number.isInteger(bytes) ||
    bytes < 1 ||
    bytes > BROWSER_NETWORK_TUNNEL_MAX_WINDOW_UPDATE_BYTES
  ) {
    throw new Error('Browser tunnel window update is invalid')
  }
  const payload = new Uint8Array(4)
  new DataView(payload.buffer).setUint32(0, bytes, false)
  return payload
}

export function decodeBrowserNetworkTunnelWindowUpdate(
  payload: Uint8Array<ArrayBufferLike>
): number | null {
  if (payload.byteLength !== 4) {
    return null
  }
  const bytes = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(
    0,
    false
  )
  return bytes > 0 && bytes <= BROWSER_NETWORK_TUNNEL_MAX_WINDOW_UPDATE_BYTES ? bytes : null
}

function validateFrameIdentity(frame: BrowserNetworkTunnelFrame): void {
  if (
    !Number.isInteger(frame.tunnelGeneration) ||
    frame.tunnelGeneration < 1 ||
    frame.tunnelGeneration > MAX_UINT32
  ) {
    throw new Error('Browser tunnel generation is invalid')
  }
  const connectionFrame =
    frame.opcode !== BrowserNetworkTunnelOpcode.Ping &&
    frame.opcode !== BrowserNetworkTunnelOpcode.Pong
  if (
    !Number.isInteger(frame.streamId) ||
    frame.streamId < (connectionFrame ? 1 : 0) ||
    frame.streamId > MAX_UINT32
  ) {
    throw new Error('Browser tunnel stream id is invalid')
  }
}

function validatePayload(
  opcode: BrowserNetworkTunnelOpcode,
  payload: Uint8Array<ArrayBufferLike>
): void {
  if (opcode === BrowserNetworkTunnelOpcode.Data) {
    if (payload.byteLength > BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES) {
      throw new Error('Browser tunnel data payload is too large')
    }
    return
  }
  if (opcode === BrowserNetworkTunnelOpcode.Open) {
    if (!decodeBrowserNetworkTunnelOpen(payload)) {
      throw new Error('Browser tunnel open payload is invalid')
    }
    return
  }
  if (opcode === BrowserNetworkTunnelOpcode.WindowUpdate) {
    if (!decodeBrowserNetworkTunnelWindowUpdate(payload)) {
      throw new Error('Browser tunnel window update payload is invalid')
    }
    return
  }
  if (
    opcode === BrowserNetworkTunnelOpcode.Opened ||
    opcode === BrowserNetworkTunnelOpcode.HalfClose ||
    opcode === BrowserNetworkTunnelOpcode.Close
  ) {
    if (payload.byteLength !== 0) {
      throw new Error('Browser tunnel control payload must be empty')
    }
    return
  }
  if (payload.byteLength > MAX_CONTROL_PAYLOAD_BYTES) {
    throw new Error('Browser tunnel control payload is too large')
  }
}

function isBrowserNetworkTunnelOpcode(value: number): value is BrowserNetworkTunnelOpcode {
  return value >= BrowserNetworkTunnelOpcode.Open && value <= BrowserNetworkTunnelOpcode.Pong
}
