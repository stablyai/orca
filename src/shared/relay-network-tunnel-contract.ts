import { Buffer } from 'node:buffer'
import {
  BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES,
  decodeBrowserNetworkTunnelFrame
} from './browser-network-tunnel-protocol'

export const RELAY_NETWORK_TUNNEL_CAPABILITY = 'relay.networkTunnel.v1'
export const RELAY_NETWORK_TUNNEL_OPEN_METHOD = 'relay.networkTunnel.open'
export const RELAY_NETWORK_TUNNEL_FRAME_METHOD = 'relay.networkTunnel.frame'
export const RELAY_NETWORK_TUNNEL_CLOSE_METHOD = 'relay.networkTunnel.close'

export const RELAY_NETWORK_TUNNEL_MAX_FRAME_BYTES = BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES + 16
const MAX_ENCODED_FRAME_LENGTH = Math.ceil(RELAY_NETWORK_TUNNEL_MAX_FRAME_BYTES / 3) * 4

export function readRelayNetworkTunnelIncarnation(status: unknown): string {
  const value = status as {
    capabilities?: unknown
    networkTunnel?: { version?: unknown; runtimeIncarnation?: unknown }
  } | null
  const incarnation = value?.networkTunnel?.runtimeIncarnation
  if (
    !Array.isArray(value?.capabilities) ||
    !value.capabilities.includes(RELAY_NETWORK_TUNNEL_CAPABILITY) ||
    value.networkTunnel?.version !== 1 ||
    typeof incarnation !== 'string' ||
    incarnation.length === 0 ||
    incarnation.length > 128
  ) {
    throw new Error('relay_network_tunnel_capability_unavailable')
  }
  return incarnation
}

export type RelayNetworkTunnelOwner = Readonly<{
  version: 1
  runtimeIncarnation: string
  ownerGeneration: number
  ownerLease: string
}>

export type RelayNetworkTunnelHandle = RelayNetworkTunnelOwner &
  Readonly<{
    tunnelGeneration: number
  }>

export type RelayNetworkTunnelFrameEnvelope = RelayNetworkTunnelHandle &
  Readonly<{
    frame: string
  }>

export function parseRelayNetworkTunnelOwner(value: unknown): RelayNetworkTunnelOwner {
  const record = value as Partial<RelayNetworkTunnelOwner> | null
  const bounded = (field: unknown, max: number) =>
    typeof field === 'string' && field.length > 0 && field.length <= max
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    record.version !== 1 ||
    !bounded(record.runtimeIncarnation, 128) ||
    !Number.isSafeInteger(record.ownerGeneration) ||
    record.ownerGeneration! < 1 ||
    !bounded(record.ownerLease, 1024)
  ) {
    throw new Error('relay_network_tunnel_invalid_owner')
  }
  return Object.freeze({
    version: 1,
    runtimeIncarnation: record.runtimeIncarnation!,
    ownerGeneration: record.ownerGeneration!,
    ownerLease: record.ownerLease!
  })
}

export function parseRelayNetworkTunnelHandle(value: unknown): RelayNetworkTunnelHandle {
  const owner = parseRelayNetworkTunnelOwner(value)
  const { tunnelGeneration } = value as Partial<RelayNetworkTunnelHandle>
  if (
    !Number.isInteger(tunnelGeneration) ||
    tunnelGeneration! < 1 ||
    tunnelGeneration! > 0xffff_ffff
  ) {
    throw new Error('relay_network_tunnel_invalid_generation')
  }
  return Object.freeze({ ...owner, tunnelGeneration: tunnelGeneration! })
}

function assertFrame(handle: RelayNetworkTunnelHandle, bytes: Uint8Array<ArrayBufferLike>): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > RELAY_NETWORK_TUNNEL_MAX_FRAME_BYTES) {
    throw new Error('relay_network_tunnel_invalid_frame')
  }
  const frame = decodeBrowserNetworkTunnelFrame(bytes)
  if (!frame || frame.tunnelGeneration !== handle.tunnelGeneration) {
    throw new Error('relay_network_tunnel_invalid_frame')
  }
}

export function encodeRelayNetworkTunnelFrame(
  value: RelayNetworkTunnelHandle,
  bytes: Uint8Array<ArrayBufferLike>
): RelayNetworkTunnelFrameEnvelope {
  const handle = parseRelayNetworkTunnelHandle(value)
  assertFrame(handle, bytes)
  return Object.freeze({ ...handle, frame: Buffer.from(bytes).toString('base64') })
}

export function decodeRelayNetworkTunnelFrame(value: unknown): {
  handle: RelayNetworkTunnelHandle
  bytes: Uint8Array<ArrayBufferLike>
} {
  const handle = parseRelayNetworkTunnelHandle(value)
  const { frame } = value as Partial<RelayNetworkTunnelFrameEnvelope>
  // Reject size before allocation; round-trip validation rejects permissive base64 decoding.
  if (typeof frame !== 'string' || frame.length === 0 || frame.length > MAX_ENCODED_FRAME_LENGTH) {
    throw new Error('relay_network_tunnel_invalid_frame')
  }
  const bytes = Buffer.from(frame, 'base64')
  if (bytes.toString('base64') !== frame) {
    throw new Error('relay_network_tunnel_invalid_frame')
  }
  assertFrame(handle, bytes)
  return { handle, bytes }
}
