// Why a WebSocket close reason and not a JSON field: every relay-hello and
// director-resolve schema on the phone is zod `.strict()`, so an added key is a
// hard parse failure on already-shipped phones. The close reason is a wire slot
// old peers never read, which makes it the only additive channel here.
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
