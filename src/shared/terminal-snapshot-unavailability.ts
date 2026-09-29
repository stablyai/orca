/**
 * Why a host answered a requested terminal-buffer snapshot without a usable buffer image.
 *
 * Sent as the additive `unavailable` field on the SnapshotStart frame. Hosts that predate
 * this field omit it, so an absent value means "the host did not say" — never "nothing exists".
 * Both current reasons are transient: the host could not answer *now*, not that the pane has
 * no retained output.
 *
 * A real snapshot with empty `data` and no reason is NOT proof the pane is empty either:
 * `serializeTerminalBufferFromAvailableState` returns the renderer serializer's un-hydrated
 * shell (`data: ''`) when a parked desktop pane registered its serializer before its xterm
 * mounted and no provider history exists. Nothing on this wire positively says "the host
 * retains nothing"; readers must treat an imageless success as unverifiable, never as empty.
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
