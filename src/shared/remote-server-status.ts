import type { DeviceScope } from './runtime-session-contracts'

export type RemoteServerGrant = {
  deviceId: string
  name: string
  scope: DeviceScope
  /** Grant creation time, in Unix milliseconds; not the first connection time. */
  createdAt: number
  lastSeenAt: number | null
}

export type RemoteServerClient = Pick<RemoteServerGrant, 'deviceId' | 'name' | 'scope'> & {
  connectionCount: number
  transports: { direct: number; relay: number }
}

export type RemoteServerStatus = {
  listener:
    | { state: 'listening'; address: string; port: number }
    | { state: 'disabled' | 'not_listening' }
  grants:
    | { state: 'unavailable' }
    | {
        state: 'available'
        total: number
        pending: number
        byScope: Record<DeviceScope, number>
        entries: RemoteServerGrant[]
        truncated: boolean
      }
  connectedClients:
    | { state: 'unavailable' }
    | {
        state: 'available'
        /** Distinct pairing identities, not physical devices. */
        count: number
        connectionCount: number
        byScope: Record<DeviceScope, number>
        entries: RemoteServerClient[]
        truncated: boolean
      }
}
