const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** The grid a snapshot was captured at, bounded to what xterm accepts; without one, the classic 80×24. */
export function previewSnapshotGrid(snap: { cols?: number; rows?: number }): {
  cols: number
  rows: number
} {
  return {
    cols: clamp(snap.cols ?? FALLBACK_COLS, 2, 500),
    rows: clamp(snap.rows ?? FALLBACK_ROWS, 2, 200)
  }
}
