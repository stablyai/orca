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

export function readProposedTerminalCols(pane: {
  fitAddon?: { proposeDimensions?: () => { cols: number; rows: number } | undefined }
}): number | undefined {
  try {
    return pane.fitAddon?.proposeDimensions?.()?.cols
  } catch {
    return undefined
  }
}

export function selectDaemonSnapshotReplayData(input: {
  snapshot: string
  snapshotFrameStart?: number
  snapshotCols?: number
  targetCols?: number
  isAlternateScreen?: boolean
  coldRestore?: boolean
}): string {
  const { snapshot, snapshotFrameStart, snapshotCols, targetCols } = input
  const hasNarrowerTarget =
    typeof snapshotCols === 'number' &&
    typeof targetCols === 'number' &&
    Number.isFinite(snapshotCols) &&
    Number.isFinite(targetCols) &&
    snapshotCols > 0 &&
    targetCols > 0 &&
    snapshotCols > targetCols
  const hasFrameBoundary =
    typeof snapshotFrameStart === 'number' &&
    Number.isInteger(snapshotFrameStart) &&
    snapshotFrameStart > 0 &&
    snapshotFrameStart < snapshot.length

  if (!input.isAlternateScreen || input.coldRestore || !hasNarrowerTarget || !hasFrameBoundary) {
    return snapshot
  }

  // The live owner repaints its absolute frame after the post-replay SIGWINCH.
  return snapshot.slice(0, snapshotFrameStart)
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
