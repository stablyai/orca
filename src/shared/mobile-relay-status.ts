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

// A cell only describes a host that is actually reachable on it. A connecting or
// offline host can still hold the assignment object it is about to reuse, and
// forwarding that leaves the UI naming a cell nothing is being served from.
const STATUSES_SERVED_FROM_A_CELL: readonly MobileRelayStatus[] = ['registered', 'draining']

export function relayStatusCellUrl(
  status: MobileRelayStatus,
  cellUrl: string | undefined
): string | undefined {
  return cellUrl !== undefined && STATUSES_SERVED_FROM_A_CELL.includes(status) ? cellUrl : undefined
}
