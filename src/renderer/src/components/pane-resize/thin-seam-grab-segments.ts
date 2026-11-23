type Box = { top: number; bottom: number; left: number; right: number }
export type GrabSegment = { top: number; height: number }

// Why: keep a press on the row's edge pixel with the row.
const ROW_SLACK_PX = 1

/**
 * Grab-area pieces of a vertical seam, in px from its top: its whole length minus every rendered tab
 * row that reaches into the grab band (the seam plus `reachPx` to its right), so tabs and their
 * buttons keep their presses. A row beside a narrow nested column can start a few px past the seam.
 */
export function getThinSeamGrabSegments(
  seam: Box,
  rows: readonly Box[],
  reachPx: number
): GrabSegment[] {
  const gaps = rows
    .filter(
      (row) => row.left < seam.right + reachPx && row.right > seam.left && row.bottom > row.top
    )
    .map((row) => ({
      top: row.top - seam.top - ROW_SLACK_PX,
      bottom: row.bottom - seam.top + ROW_SLACK_PX
    }))
    .sort((a, b) => a.top - b.top)
  const length = seam.bottom - seam.top
  const segments: GrabSegment[] = []
  let from = 0
  for (const gap of gaps) {
    if (gap.top > from) {
      segments.push({ top: from, height: gap.top - from })
    }
    from = Math.max(from, gap.bottom)
  }
  if (length > from) {
    segments.push({ top: from, height: length - from })
  }
  return segments
}

export function sameGrabSegments(a: readonly GrabSegment[], b: readonly GrabSegment[]): boolean {
  return (
    a.length === b.length &&
    a.every((segment, index) => segment.top === b[index].top && segment.height === b[index].height)
  )
}
