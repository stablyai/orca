export type FitGrid = {
  cols: number
  rows: number
}

export type AppliedRowFlip = {
  cols: number
  fromRows: number
  toRows: number
}

/** The row change a stable fit is about to apply, when it moves exactly one row and leaves columns alone. */
export function rowFlipToRemember(current: FitGrid, proposed: FitGrid): AppliedRowFlip | null {
  if (current.cols !== proposed.cols || current.cols < 2) {
    return null
  }
  if (current.rows < 1 || proposed.rows < 1) {
    return null
  }
  if (Math.abs(current.rows - proposed.rows) !== 1) {
    return null
  }
  return { cols: current.cols, fromRows: current.rows, toRows: proposed.rows }
}

/**
 * True when this proposal undoes the one-row fit just applied.
 * That echo is the cell-boundary loop (#20822): fitting it flips the grid and the observer runs again.
 */
export function isEchoOfLastRowFlip(
  last: AppliedRowFlip | undefined,
  current: FitGrid,
  proposed: FitGrid
): boolean {
  if (!last) {
    return false
  }
  return (
    last.cols === current.cols &&
    last.cols === proposed.cols &&
    last.toRows === current.rows &&
    last.fromRows === proposed.rows &&
    Math.abs(current.rows - proposed.rows) === 1
  )
}
