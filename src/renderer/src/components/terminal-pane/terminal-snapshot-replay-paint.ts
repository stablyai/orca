import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { readProposedPaneFitDimensions } from '@/lib/pane-manager/pane-fit'
import {
  ABORT_TRUNCATED_CONTROL_STRING,
  buildSnapshotReplayPrologue
} from '../../../../shared/terminal-mode-reset-profiles'
import { splitAtAlternateScreenEntry } from '../../../../shared/terminal-alternate-screen-split'

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
 * The column count the post-replay fit will land on. Why not terminal.cols: a
 * pane that has not been fitted yet still reads xterm's 80-column default, so
 * comparing against it would drop frames whose width actually matches the
 * container. Returns undefined when the pane cannot be measured, so replay can
 * retain the frame at its capture grid until a final fit exists.
 */
export function readProposedTerminalCols(pane: ManagedPane): number | undefined {
  return readProposedPaneFitDimensions(pane)?.cols
}

export function shouldSkipAltFrameForWidthMismatch(
  snapshotCols: number | undefined,
  targetCols: number | undefined
): boolean {
  if (typeof snapshotCols !== 'number' || !Number.isFinite(snapshotCols) || snapshotCols <= 0) {
    return false
  }
  if (typeof targetCols !== 'number' || !Number.isFinite(targetCols) || targetCols <= 0) {
    // Keep the frame at its capture grid until a real fit can replace that grid.
    return false
  }
  // Fixed-grid alt rows clip at narrower columns; normal history remains reflowable.
  return snapshotCols > targetCols
}

/** First write of a snapshot replay; CAN aborts a control string the gap truncated. */
export function buildSnapshotReplayPreamble(
  args: Parameters<typeof buildSnapshotReplayPrologue>[0]
): string {
  return `${ABORT_TRUNCATED_CONTROL_STRING}${buildSnapshotReplayPrologue(args)}`
}

/**
 * Writes for a remote image, which folds its normal buffer in ahead of its alt
 * entry. Over a pane already on alt, an image that ends on alt repaints only its
 * alt payload, so the pane's normal buffer and history stay as they are; any
 * other image paints from the normal buffer.
 */
export function buildFoldedImageReplayWrites(
  data: string,
  paneOnAlternateScreen: boolean,
  keepScrollback = false
): { preamble: string; payload: string } {
  const split = paneOnAlternateScreen ? splitAtAlternateScreenEntry(data) : null
  if (split) {
    return {
      preamble: buildSnapshotReplayPreamble({
        targetAlternateScreen: true,
        paneOnAlternateScreen: true
      }),
      payload: split.alternateAnsi
    }
  }
  return {
    preamble: buildSnapshotReplayPreamble({
      targetAlternateScreen: false,
      paneOnAlternateScreen,
      keepScrollback
    }),
    payload: data
  }
}

/**
 * Ordered replay writes for a main-model snapshot, including the alt-screen
 * choreography: main strips the `?1049h` marker when splitting scrollbackAnsi
 * from an alt frame, so the restorer owns the transition — rebuild the normal
 * buffer while on it, then paint the alt frame clean. Callers write these
 * before their post-replay reset/escape-tail sequences.
 *
 * `skipAltFrame` drops only the frame paint, never the buffer choreography or
 * scrollback or mode rehydration: the alt buffer is still entered and cleared
 * so the caller's SIGWINCH lands on a clean screen the application repaints.
 */
export function buildMainModelSnapshotReplayWrites(
  snapshot: {
    data: string
    /** Live state that can be restored without an alternate-screen frame. */
    frameRestoreAnsi?: string
    alternateScreen?: boolean
    scrollbackAnsi?: string
    carriesNormalBuffer?: boolean
  },
  options: { skipAltFrame?: boolean; paneOnAlternateScreen: boolean }
): string[] {
  const { paneOnAlternateScreen } = options
  // The alt payload always follows a hop through the normal buffer in the split
  // branch, so its own switch is judged from there, not from where we started.
  const altPrologue = (fromAlternateScreen: boolean): string =>
    buildSnapshotReplayPrologue({
      targetAlternateScreen: true,
      paneOnAlternateScreen: fromAlternateScreen
    })
  // Why the switch can be needed here: the gap can eat the TUI's own exit
  // sequence, leaving the renderer on alt while the model moved to normal —
  // the restored history would paint into the alt buffer, looking right while
  // scrollback stays empty (STA-4042). An image carrying its normal buffer
  // enters alt itself, so it needs the same start.
  const normalPreamble = buildSnapshotReplayPreamble({
    targetAlternateScreen: false,
    paneOnAlternateScreen
  })
  if (!snapshot.alternateScreen || snapshot.carriesNormalBuffer) {
    return [normalPreamble, snapshot.data]
  }
  // Older snapshot producers do not expose the mode/frame boundary. Keep their
  // composed data rather than dropping terminal modes together with the frame.
  const altFrame =
    options.skipAltFrame && snapshot.frameRestoreAnsi !== undefined
      ? [snapshot.frameRestoreAnsi]
      : [snapshot.data]
  if (snapshot.scrollbackAnsi !== undefined) {
    // Why a prologue per payload: main serializes the buffers separately and
    // each is diffed against the baseline. scrollbackAnsi used to replay before
    // any reset at all, so the history inherited the stale state (STA-4042).
    return [normalPreamble, snapshot.scrollbackAnsi, altPrologue(false), ...altFrame]
  }
  // Why the prologue clears: `?1049h` does not clear the alt buffer, so the
  // pre-hide frame would bleed through the snapshot's blank cells.
  return [
    buildSnapshotReplayPreamble({ targetAlternateScreen: true, paneOnAlternateScreen }),
    ...altFrame
  ]
}
