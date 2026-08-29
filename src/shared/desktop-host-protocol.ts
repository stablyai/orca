import { PAIRING_OFFER_VERSION, type PairingOffer } from './pairing'

// Why: packaged Orca still uses 6768; the Tauri/Pake host must not steal it
// during `pnpm dev` or local smoke. Keep the desktop sidecar on 6769.
export const DESKTOP_HOST_DEV_PORT = 6769
export const DESKTOP_HOST_KIND = 'tauri-sidecar' as const

export const DESKTOP_HOST_CAPABILITIES = [
  'desktop.host.v1',
  'desktop.ipc.v1',
  'desktop.pty.v1',
  'runtime.status.compat.v1'
] as const

export type DesktopHostCapability = (typeof DESKTOP_HOST_CAPABILITIES)[number]

export type DesktopHostInfo = {
  host: typeof DESKTOP_HOST_KIND
  runtimeId: string
  httpUrl: string
  ipcUrl: string
  pairing: PairingOffer
  pairingUrl: string
  platform: NodeJS.Platform
  osRelease: string
  capabilities: DesktopHostCapability[]
}

export type DesktopIpcInvokeRequest = {
  type: 'invoke'
  id: string
  channel: string
  args?: unknown
}

export type DesktopIpcSendRequest = {
  type: 'send'
  channel: string
  args?: unknown
}

export type DesktopIpcClientMessage = DesktopIpcInvokeRequest | DesktopIpcSendRequest

export type DesktopIpcInvokeSuccess = {
  type: 'result'
  id: string
  ok: true
  result: unknown
}

export type DesktopIpcInvokeFailure = {
  type: 'result'
  id: string
  ok: false
  error: {
    code: string
    message: string
  }
}

export type DesktopIpcEvent = {
  type: 'event'
  channel: string
  args: unknown
}

export type DesktopIpcServerMessage =
  | DesktopIpcInvokeSuccess
  | DesktopIpcInvokeFailure
  | DesktopIpcEvent

export type DesktopPtySpawnArgs = {
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  command?: string
}

export type DesktopPtySpawnResult = {
  id: string
}

export type DesktopPtyWriteArgs = {
  id: string
  data: string
}

export type DesktopPtyResizeArgs = {
  id: string
  cols: number
  rows: number
}

export type DesktopPtyKillArgs = {
  id: string
}

export type DesktopPtyDataEvent = {
  id: string
  data: string
}

export type DesktopPtyExitEvent = {
  id: string
  code: number
}

export type DesktopHostStatus = {
  runtimeId: string
  host: typeof DESKTOP_HOST_KIND
  graphStatus: 'ready'
  authoritativeWindowId: null
  liveTabCount: number
  liveLeafCount: number
  rendererGraphEpoch: number
  runtimeProtocolVersion: number
  capabilities: DesktopHostCapability[]
  hostPlatform: NodeJS.Platform
}

export function isDesktopIpcClientMessage(value: unknown): value is DesktopIpcClientMessage {
  if (!value || typeof value !== 'object') {
    return false
  }
  const message = value as { type?: unknown; channel?: unknown; id?: unknown }
  if (message.type === 'send') {
    return typeof message.channel === 'string'
  }
  return (
    message.type === 'invoke' &&
    typeof message.channel === 'string' &&
    typeof message.id === 'string'
  )
}

export function pairingOfferVersion(): typeof PAIRING_OFFER_VERSION {
  return PAIRING_OFFER_VERSION
}
