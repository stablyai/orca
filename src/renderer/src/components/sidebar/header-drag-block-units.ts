/** Resolve the dragged header's block (a project + its worktrees, or a group +
 *  its whole subtree) into movable units ready for gap-opening shift
 *  computation. Extracted from computeHeaderDragRowOffsets so this pure
 *  segmentation step can be tested independently of the scroll-offset layer. */
import type { RenderRow } from './worktree-list-virtual-rows'

export type HeaderDragBlockUnits = {
  /** Render keys of every row in the dragged block (kept hidden during drag). */
  blockKeys: Set<string>
  /** Movable units: header + all rows that must move with it as one piece. */
  units: { headerTop: number; rowKeys: string[] }[]
  /** Container-relative top of the first row in the dragged block. */
  blockTop: number
  /** Container-relative bottom of the last row in the dragged block. */
  blockBottom: number
}

export function resolveHeaderDragBlockUnits(args: {
  renderRows: readonly RenderRow[]
  virtualItems: readonly { index: number; start: number; size: number }[]
  draggingRepoId: string | null
  draggingGroupId: string | null
  /** Maps a RenderRow to its unique render key — injected to avoid a circular
   *  import back to the React component module. */
  getRowKey: (row: RenderRow) => string
}): HeaderDragBlockUnits | null {
  if (args.draggingRepoId === null && args.draggingGroupId === null) {
    return null
  }
  const isGroup = args.draggingGroupId !== null
  let headerIndex = -1
  for (let i = 0; i < args.renderRows.length; i++) {
    const row = args.renderRows[i]!
    if (row.type !== 'header') {
      continue
    }
    if (
      isGroup ? row.projectGroup?.id === args.draggingGroupId : row.repo?.id === args.draggingRepoId
    ) {
      headerIndex = i
      break
    }
  }
  if (headerIndex === -1) {
    return null
  }
  const headerRow = args.renderRows[headerIndex]!
  const draggedDepth = headerRow.type === 'header' ? (headerRow.projectGroupDepth ?? 0) : 0
  // A project block ends at the next header; a group block extends through its
  // nested rows until a header at the same or shallower group depth.
  let endIndex = args.renderRows.length
  for (let i = headerIndex + 1; i < args.renderRows.length; i++) {
    const row = args.renderRows[i]!
    if (row.type !== 'header') {
      continue
    }
    if (!isGroup || (row.projectGroupDepth ?? 0) <= draggedDepth) {
      endIndex = i
      break
    }
  }
  const startByIndex = new Map<number, number>()
  const sizeByIndex = new Map<number, number>()
  for (const item of args.virtualItems) {
    startByIndex.set(item.index, item.start)
    sizeByIndex.set(item.index, item.size)
  }
  const blockTop = startByIndex.get(headerIndex)
  if (blockTop === undefined) {
    return null
  }
  let blockBottom = startByIndex.get(endIndex)
  if (blockBottom === undefined) {
    let sum = 0
    for (let i = headerIndex; i < endIndex; i++) {
      sum += sizeByIndex.get(i) ?? 0
    }
    blockBottom = blockTop + sum
  }
  const blockKeys = new Set<string>()
  for (let i = headerIndex; i < endIndex; i++) {
    blockKeys.add(args.getRowKey(args.renderRows[i]!))
  }
  // Segment the visible rows into movable units (whole blocks) so a block's
  // children always shift with their header. Project drag treats every header
  // (project AND group) as its own unit, so the list reflows flatly — group
  // dividers slide up with everything else, leaving no overlap. Group drag
  // moves sibling-group blocks (their whole subtree, nested headers included).
  const startsUnit = (row: RenderRow): boolean =>
    row.type === 'header' &&
    (isGroup
      ? row.projectGroup != null &&
        row.projectGroup.id !== null &&
        (row.projectGroupDepth ?? 0) === draggedDepth
      : true)
  const continuesUnit = (row: RenderRow): boolean =>
    isGroup && row.type === 'header' && (row.projectGroupDepth ?? 0) > draggedDepth
  const units: { headerTop: number; rowKeys: string[] }[] = []
  let current: { headerTop: number; rowKeys: string[] } | null = null
  const flush = (): void => {
    if (current && current.rowKeys.length > 0) {
      units.push(current)
    }
    current = null
  }
  for (let i = 0; i < args.renderRows.length; i++) {
    const row = args.renderRows[i]!
    const key = args.getRowKey(row)
    if (startsUnit(row)) {
      flush()
      const top = startByIndex.get(i)
      current = top === undefined ? null : { headerTop: top, rowKeys: [key] }
    } else if (row.type === 'header' && !continuesUnit(row)) {
      // A header that is not part of the current block (e.g. a group header
      // during project drag) stays put and closes the open unit.
      flush()
    } else if (current) {
      current.rowKeys.push(key)
    }
  }
  flush()
  return { blockKeys, units, blockTop, blockBottom }
}
