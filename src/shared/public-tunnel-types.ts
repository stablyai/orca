/** Shared contract between the desktop main process, preload bridge, and Settings UI. */

export type PublicTunnelStatus = 'idle' | 'starting' | 'connected' | 'stopping' | 'error'

export type PublicTunnelErrorCode =
  | 'cloudflared_not_found'
  | 'start_failed'
  | 'timeout'
  | 'runtime_unavailable'
  | 'pairing_unavailable'
  | 'unsupported'

export type PublicTunnelError = {
  code: PublicTunnelErrorCode
  message: string
  guidance?: string
}

export type PublicTunnelState = {
  status: PublicTunnelStatus
  /** The Cloudflare edge URL; null until connected. */
  publicUrl: string | null
  /** The mobile shell URL with the pairing credential in its fragment. */
  remoteUrl: string | null
  /** The desktop web client URL for the same host, if the runtime serves one. */
  webClientUrl: string | null
  /** Raw pairing code for clients that paste it instead of opening the URL. */
  pairingUrl: string | null
  deviceId: string | null
  qrDataUrl: string | null
  qrSize: number | null
  error: PublicTunnelError | null
  startedAt: number | null
}

export function idlePublicTunnelState(): PublicTunnelState {
  return {
    status: 'idle',
    publicUrl: null,
    remoteUrl: null,
    webClientUrl: null,
    pairingUrl: null,
    deviceId: null,
    qrDataUrl: null,
    qrSize: null,
    error: null,
    startedAt: null
  }
}
