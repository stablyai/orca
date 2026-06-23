// Shared tailnet status shapes used across main, preload, and renderer.

export type TailscaleNodeState = 'Stopped' | 'Starting' | 'NeedsLogin' | 'Running'

export type TailscaleStatus = {
  state: TailscaleNodeState
  tailnetIp?: string
  magicDnsName?: string
  /** Present when the node needs interactive login; the desktop opens it. */
  authUrl?: string
  /** Loopback port of the sidecar's outbound SOCKS5 proxy. */
  socksPort?: number
}

export type TailscaleStatusResult = {
  /** False when this build ships no sidecar binary; the UI hides tailnet affordances. */
  available: boolean
  status: TailscaleStatus | null
}
