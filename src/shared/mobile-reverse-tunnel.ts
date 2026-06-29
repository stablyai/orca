export type MobileReverseTunnelStatus = 'starting' | 'running' | 'failed' | 'stopping'

export type MobileReverseTunnelStartArgs = {
  targetId: string
  publicHost: string
  remotePort: number
  localPort: number
  remoteBindHost?: string
}

export type MobileReverseTunnelEntry = {
  id: string
  targetId: string
  targetLabel: string
  publicHost: string
  remoteBindHost: string
  remotePort: number
  localHost: string
  localPort: number
  advertisedAddress: string
  status: MobileReverseTunnelStatus
  error: string | null
  startedAt: number
  updatedAt: number
}

export type MobileReverseTunnelListResult = {
  tunnels: MobileReverseTunnelEntry[]
}

export type MobileReverseTunnelStopResult = {
  stopped: boolean
}
