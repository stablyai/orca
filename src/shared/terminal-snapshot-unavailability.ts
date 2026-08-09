/**
 * Why a host answered a requested terminal-buffer snapshot without a usable buffer image.
 *
 * Sent as the additive `unavailable` field on the SnapshotStart frame. Hosts that predate
 * this field omit it, so an absent value means "the host did not say" — never "nothing exists".
 * Both current reasons are transient: the host could not answer *now*, not that the pane has
 * no retained output. A pane that genuinely has nothing still comes back as a real snapshot
 * whose `data` is empty, because the host successfully serialized and found it empty.
 */
export const TERMINAL_SNAPSHOT_UNAVAILABLE_REASONS = [
  // The pending-output buffer overflowed twice while serializing, so the reply was truncated to nothing.
  'pending-output-overflowed',
  // No serializer (provider, renderer, headless) produced a buffer for this pty at request time.
  'no-serializable-buffer'
] as const

export type TerminalSnapshotUnavailableReason =
  (typeof TERMINAL_SNAPSHOT_UNAVAILABLE_REASONS)[number]

export function parseTerminalSnapshotUnavailableReason(
  value: unknown
): TerminalSnapshotUnavailableReason | undefined {
  return TERMINAL_SNAPSHOT_UNAVAILABLE_REASONS.find((reason) => reason === value)
}
