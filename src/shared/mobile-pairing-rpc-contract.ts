// Why: Web/desktop/CLI clients drive pairing over the runtime WebSocket transport; the IPC surface in
// `src/main/ipc/mobile.ts` stays for the Electron renderer. Names here are wire-stable — mixed-version
// hosts and clients must agree exactly, so changes here are remote-wire-compatibility changes.
import { z } from 'zod'
import type { RuntimeDesktopWindowStatus } from './runtime-session-contracts'

export type MobileHostMode = 'desktop' | 'serve'

export type MobileHostStatus = {
  /** Mirrors `desktopWindowStatus` from `status.get` (null on hosts that never set it). */
  desktopWindowStatus: RuntimeDesktopWindowStatus | null
  /** 'serve' on headless `orca serve`; 'desktop' on the desktop app. */
  hostMode: MobileHostMode
  /** True if the host has a live DesktopRelayService (currently false on serve). */
  relayAvailable: boolean
  /** Reachable runtime WS endpoint ('ws://host:port') or null when down. */
  webSocketEndpoint: string | null
}

export type MobileHostStatusResult = MobileHostStatus

export type MobileNetworkInterface = {
  name: string
  address: string
  family: 'IPv4' | 'IPv6'
}

export type MobileNetworkInterfacesResult = {
  interfaces: MobileNetworkInterface[]
}

export type MobilePairedDevice = {
  deviceId: string
  name: string
  pairedAt: number
  lastSeenAt: number
}

export type MobileListDevicesResult = {
  devices: MobilePairedDevice[]
}

export type MobileRevokeDeviceResult = { revoked: boolean }

export type MobilePairingQrUnavailable = {
  available: false
  reason: string
  guidance: string
}

export type MobilePairingQrAvailable = {
  available: true
  qrDataUrl: string | null
  qrSize: number | null
  pairingUrl: string
  endpoint: string | null
  deviceId: string
  connectionMode: 'local-only' | 'automatic' | null
}

export type MobilePairingQrResult = MobilePairingQrUnavailable | MobilePairingQrAvailable

export type MobileRuntimePairingUrlUnavailable = {
  available: false
  reason?: string
  guidance?: string
}

export type MobileRuntimePairingUrlAvailable = {
  available: true
  pairingUrl: string
  webClientUrl: string
  endpoint: string
  deviceId: string
}

export type MobileRuntimePairingUrlResult =
  | MobileRuntimePairingUrlUnavailable
  | MobileRuntimePairingUrlAvailable

export const MobileGetPairingQrParamsSchema = z
  .object({
    address: z.string().optional(),
    connectionMode: z.union([z.literal('local-only'), z.literal('automatic')]).optional(),
    rotate: z.boolean().optional()
  })
  .optional()

export const MobileRevokeDeviceParamsSchema = z.object({ deviceId: z.string().min(1) })

export const MobileGetRuntimePairingUrlParamsSchema = z
  .object({
    address: z.string().optional(),
    rotate: z.boolean().optional(),
    reach: z.union([z.literal('this-computer'), z.literal('network')]).optional()
  })
  .optional()
