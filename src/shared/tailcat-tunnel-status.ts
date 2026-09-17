import type { PairingTunnel } from './mobile-relay-pairing-offer'

export type TailcatTunnelServerState = 'stopped' | 'starting' | 'running' | 'failed'

/** Owned by the host process: hands the RPC server the tunnel token to embed in offers. */
export type RuntimeTunnelAdvertiser = {
  getPairingTunnel(port: number): Omit<PairingTunnel, 'port'> | null
}

/** What the renderer needs to explain the Tailcat option: is the CLI here, and is the tunnel up. */
export type TailcatTunnelStatus = {
  installed: boolean
  binaryPath: string | null
  installHint: string
  /** Null until the behavioral probe has run; false means the binary exists but is not usable. */
  compatible: boolean | null
  version: string | null
  incompatibleReason: string | null
  server: { state: TailcatTunnelServerState; port: number | null }
}
