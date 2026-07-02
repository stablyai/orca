/** Gap-opening offsets for a header drag, mirroring the worktree drag feel: the
 *  dragged block (a project header + its worktrees, or a group + its subtree) is
 *  hidden behind the floating clone, and the rows between its old slot and the
 *  drop line slide by the block's height to open the gap.
 *
 *  Shifts are computed per UNIT (block), not per row, so a block's children
 *  always move with their header — otherwise a header whose children sit below
 *  the drop line would detach from them. */
export type HeaderDragUnit = {
  /** Top (container-relative) of the unit's header row — decides whether the
   *  whole unit shifts. */
  headerTop: number
  /** Render keys of every row in the unit (header + descendants). */
  rowKeys: readonly string[]
}

export function computeHeaderDragRowShifts(args: {
  units: readonly HeaderDragUnit[]
  /** Render keys of the dragged block's rows; its unit never shifts (hidden). */
  blockKeys: ReadonlySet<string>
  blockTop: number
  blockBottom: number
  /** Y of the drop line where the block will land (same space as headerTop). */
  dropY: number
}): Map<string, number> {
  const offsets = new Map<string, number>()
  const height = args.blockBottom - args.blockTop
  if (height <= 0) {
    return offsets
  }
  const movingDown = args.dropY > args.blockTop
  for (const unit of args.units) {
    if (unit.rowKeys.some((key) => args.blockKeys.has(key))) {
      continue
    }
    let shift = 0
    if (movingDown) {
      // Units below the dragged block and above the drop line slide up into
      // its vacated slot; the freed space opens at the drop line.
      if (unit.headerTop >= args.blockBottom && unit.headerTop < args.dropY) {
        shift = -height
      }
    } else if (unit.headerTop >= args.dropY && unit.headerTop < args.blockTop) {
      // Moving up: units from the drop line down to the block slide down.
      shift = height
    }
    if (shift !== 0) {
      for (const key of unit.rowKeys) {
        offsets.set(key, shift)
      }
    }
  }
  return offsets
}
