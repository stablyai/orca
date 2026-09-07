export const MOBILE_RELAY_STATUSES = [
  'connecting',
  'registered',
  'standby',
  'draining',
  'offline'
] as const

export type MobileRelayStatus = (typeof MOBILE_RELAY_STATUSES)[number]

/**
 * Relay status plus the assignment behind it. `cellUrl` is optional because the
 * host holds no assignment while offline, and because paired web clients answer
 * this call from a local stub that never has one.
 */
export type MobileRelayStatusDetail = {
  status: MobileRelayStatus
  cellUrl?: string
}
