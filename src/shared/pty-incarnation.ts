export type PtyIncarnationId = string

export function isPtyIncarnationId(value: unknown): value is PtyIncarnationId {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

/** Stand-in minted locally when a host reported no incarnation of its own. */
export const SYNTHESIZED_PTY_INCARNATION_PREFIX = 'legacy:'

/**
 * True only for an incarnation the HOST minted. A synthesized one is first-write-wins and is
 * dropped when provider state resets, so the same live shell can present a different value on a
 * later reconnect. Durable identity may only be recorded from — and compared against — a value the
 * host itself attested, or a reconnect would read its own stand-in as a different shell.
 */
export function isRelayAttestedPtyIncarnationId(value: unknown): value is PtyIncarnationId {
  return isPtyIncarnationId(value) && !value.startsWith(SYNTHESIZED_PTY_INCARNATION_PREFIX)
}
