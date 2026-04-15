// Why: raised from 1 to 5 so the button only appears after a deliberate scroll
// (a few visible lines), not on any transient viewport nudge.
export const SCROLLED_AWAY_THRESHOLD = 20

export type PaneJumpState = {
  showJumpToPresent: boolean
  hiddenLineCount: number
}

type TerminalBufferViewport = {
  baseY: number
  viewportY: number
}

// Why: the design intentionally tolerates a one-line delta before showing the
// affordance because xterm can transiently perturb viewportY during resize,
// split, and refit flows. Without this threshold, the button would flash while
// Orca is preserving the user's current bottom-of-buffer position.
export function getPaneJumpState(buffer: TerminalBufferViewport): PaneJumpState {
  const hiddenLineCount = Math.max(0, buffer.baseY - buffer.viewportY)
  return {
    showJumpToPresent: hiddenLineCount > SCROLLED_AWAY_THRESHOLD,
    hiddenLineCount
  }
}
