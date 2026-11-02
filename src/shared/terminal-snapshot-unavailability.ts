/** Additive SnapshotStart reasons are transient; old hosts omit them, so absence proves nothing.
 * Even an empty successful image is unverifiable: a parked renderer can register an unhydrated serializer before xterm mounts.
 * Nothing on this wire proves the host retains no output. */
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
