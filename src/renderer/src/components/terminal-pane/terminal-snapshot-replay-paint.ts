/**
 * Shared guards and write choreography for painting a main-model snapshot into
 * a (possibly fresh) xterm. One source for the reattach/hidden-restore paint
 * paths so their dimension guards and alt-screen branches cannot drift.
 */

/** True only for finite positive numeric cols/rows — Infinity/NaN/undefined
 *  from a malformed snapshot must degrade to "no resize", never reach
 *  terminal.resize(). */
export function hasPositiveTerminalDimensions(cols: unknown, rows: unknown): boolean {
  return (
    typeof cols === 'number' &&
    typeof rows === 'number' &&
    Number.isFinite(cols) &&
    Number.isFinite(rows) &&
    cols > 0 &&
    rows > 0
  )
}

/** Narrowing form of hasPositiveTerminalDimensions for optional-typed payloads. */
export function resolvePositiveTerminalDimensions(
  cols: unknown,
  rows: unknown
): { cols: number; rows: number } | null {
  return hasPositiveTerminalDimensions(cols, rows)
    ? { cols: cols as number, rows: rows as number }
    : null
}

/**
 * Ordered replay writes for a main-model snapshot, including the alt-screen
 * choreography: main strips the `?1049h` marker when splitting scrollbackAnsi
 * from an alt frame, so the restorer owns the transition — rebuild the normal
 * buffer while on it, then paint the alt frame clean. Callers write these
 * before their post-replay reset/escape-tail sequences.
 */
export function buildMainModelSnapshotReplayWrites(snapshot: {
  data: string
  alternateScreen?: boolean
  scrollbackAnsi?: string
}): string[] {
  if (!snapshot.alternateScreen) {
    // Why: \x1b[3J wipes xterm scrollback; safe here because a normal-buffer
    // snapshot carries its own history in data (mirrors pty-transport.ts).
    return ['\x1b[2J\x1b[3J\x1b[H', snapshot.data]
  }
  if (snapshot.scrollbackAnsi !== undefined) {
    // Why: main serializes normal + alt buffers separately; rebuild normal
    // while active, then return to a clean alt frame.
    return [
      '\x1b[?1049l\x1b[2J\x1b[3J\x1b[H',
      snapshot.scrollbackAnsi,
      '\x1b[0m\x1b[?1049h\x1b[2J\x1b[H',
      snapshot.data
    ]
  }
  // Why: the snapshot's ?1049h no-ops when already on alt screen and skips
  // blank cells; clear the alt buffer so the pre-hide frame can't bleed
  // through blank cells (spares normal-buffer scrollback).
  return ['\x1b[0m\x1b[?1049h\x1b[2J\x1b[H', snapshot.data]
}
