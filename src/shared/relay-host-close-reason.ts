// Shipped phones strictly parse relay-hello/director-resolve JSON; new fields break them. WebSocket close reasons
// provide an additive slot older peers ignore.
export const RELAY_HOST_CLOSE_REASON = {
  // The desktop lost its Orca Cloud session (cleared, or refused with 401).
  SIGNED_OUT: 'signed-out'
} as const

export type RelayHostCloseReason =
  (typeof RELAY_HOST_CLOSE_REASON)[keyof typeof RELAY_HOST_CLOSE_REASON]

const REASONS: readonly string[] = Object.values(RELAY_HOST_CLOSE_REASON)

// Close reasons are attacker-adjacent free text; only exact known members count.
export function relayHostCloseReasonFrom(value: unknown): RelayHostCloseReason | null {
  const text = typeof value === 'string' ? value : (value?.toString() ?? '')
  return REASONS.includes(text) ? (text as RelayHostCloseReason) : null
}
