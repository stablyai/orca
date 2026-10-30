import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { readProposedPaneFitDimensions } from '@/lib/pane-manager/pane-fit'
import {
  ABORT_TRUNCATED_CONTROL_STRING,
  buildSnapshotReplayPrologue
} from '../../../../shared/terminal-mode-reset-profiles'
import { splitAtAlternateScreenEntry } from '../../../../shared/terminal-alternate-screen-split'

/** Shared snapshot paint ordering keeps reattach/hidden restore dimension and buffer-switch rules aligned. */

/** Reject nonfinite/nonpositive dimensions before malformed snapshots reach terminal.resize. */
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

/** Compare with proposed fit, not xterm’s unfitted 80-column default; unknown measurement retains the captured frame grid. */
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

/** Folded images with history replace normal history even across live-alt gaps; screen-only images repaint alt without erasing pre-TUI scrollback. */
export function buildFoldedImageReplayWrites(
  data: string,
  paneOnAlternateScreen: boolean,
  carriesHistory: boolean
): { preamble: string; payload: string } {
  const split = paneOnAlternateScreen && !carriesHistory ? splitAtAlternateScreenEntry(data) : null
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
    preamble: buildSnapshotReplayPreamble({ targetAlternateScreen: false, paneOnAlternateScreen }),
    payload: data
  }
}

/** Rebuild normal history then paint clean alt: main strips split payloads’ alt entry. Write before mode/escape-tail restoration; skipAltFrame still preserves buffer transitions, clear, scrollback and modes for SIGWINCH repaint. */
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
  // The split branch paints alt only after rebuilding normal, so judge its switch from normal.
  const altPrologue = (fromAlternateScreen: boolean): string =>
    buildSnapshotReplayPrologue({
      targetAlternateScreen: true,
      paneOnAlternateScreen: fromAlternateScreen
    })
  // Missed exit can leave renderer on alt while model is normal; switch before replay so history is not trapped there. Folded normal-buffer images own their later alt entry.
  const normalPreamble = buildSnapshotReplayPreamble({
    targetAlternateScreen: false,
    paneOnAlternateScreen
  })
  if (!snapshot.alternateScreen || snapshot.carriesNormalBuffer) {
    return [normalPreamble, snapshot.data]
  }
  // Older producers lack a mode/frame boundary; retain composed data so skipping frame cannot discard modes.
  const altFrame =
    options.skipAltFrame && snapshot.frameRestoreAnsi !== undefined
      ? [snapshot.frameRestoreAnsi]
      : [snapshot.data]
  if (snapshot.scrollbackAnsi !== undefined) {
    // Reset each separately serialized buffer before its baseline-diffed payload can inherit gap state (STA-4042).
    return [normalPreamble, snapshot.scrollbackAnsi, altPrologue(false), ...altFrame]
  }
  // ?1049h does not clear alt; erase stale cells before painting snapshot blanks.
  return [
    buildSnapshotReplayPreamble({ targetAlternateScreen: true, paneOnAlternateScreen }),
    ...altFrame
  ]
}
