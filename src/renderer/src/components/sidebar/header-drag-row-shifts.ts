/** Gap-opening offsets for a header drag, mirroring the worktree drag feel: the
 *  dragged block (a project header + its worktrees, or a group + its subtree) is
 *  hidden behind the floating clone, and the rows between its old slot and the
 *  drop line slide by the block's height to open the gap. */
export type HeaderDragRow = {
  key: string
  top: number
}

export function computeHeaderDragRowShifts(args: {
  rows: readonly HeaderDragRow[]
  /** Render keys of the rows that make up the dragged block (hidden, not shifted). */
  blockKeys: ReadonlySet<string>
  blockTop: number
  blockBottom: number
  /** Y of the drop line where the block will land (container-relative, same
   *  space as row tops). */
  dropY: number
}): Map<string, number> {
  const offsets = new Map<string, number>()
  const height = args.blockBottom - args.blockTop
  if (height <= 0) {
    return offsets
  }
  const movingDown = args.dropY > args.blockTop
  for (const row of args.rows) {
    if (args.blockKeys.has(row.key)) {
      continue
    }
    if (movingDown) {
      // Rows below the block and above the drop line move up to fill its slot;
      // the freed space appears at the drop line.
      if (row.top >= args.blockBottom && row.top < args.dropY) {
        offsets.set(row.key, -height)
      }
    } else if (row.top >= args.dropY && row.top < args.blockTop) {
      // Moving up: rows from the drop line down to the block slide down.
      offsets.set(row.key, height)
    }
  }
  return offsets
}
