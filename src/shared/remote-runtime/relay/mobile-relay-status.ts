export const MOBILE_RELAY_STATUSES = [
  'connecting',
  'registered',
  'standby',
  'draining',
  'offline'
] as const

export type MobileRelayStatus = (typeof MOBILE_RELAY_STATUSES)[number]

/** cellUrl is absent offline or from paired-web local stubs, which hold no assignment. */
export type MobileRelayStatusDetail = {
  status: MobileRelayStatus
  cellUrl?: string
  /** Local clock minus Relay issuedAt; positive means the computer is ahead. */
  clockOffsetMs?: number
}

export type MobileRelayStatusPublisher = (
  status: MobileRelayStatus,
  cellUrl?: string,
  clockOffsetMs?: number
) => void

// Offline/connecting hosts may retain an assignment for reuse; publish a cell only while actually serving there.
const STATUSES_SERVED_FROM_A_CELL: readonly MobileRelayStatus[] = ['registered', 'draining']

export function relayStatusCellUrl(
  status: MobileRelayStatus,
  cellUrl: string | undefined
): string | undefined {
  return cellUrl !== undefined && STATUSES_SERVED_FROM_A_CELL.includes(status) ? cellUrl : undefined
}
