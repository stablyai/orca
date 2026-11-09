import type {
  GroupHeaderRow,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'

export type IndentGuideSegment = { level: number; top: number; bottom: number }

type MeasuredRow = { index: number; start: number; end: number }

function isProjectHierarchyHeader(row: RenderRow, groupBy: WorktreeGroupBy): row is GroupHeaderRow {
  return (
    groupBy === 'repo' &&
    row.type === 'header' &&
    (row.repo !== undefined || row.projectGroup !== undefined)
  )
}

/**
 * How many ancestor levels each row sits under, one guide per level. A header sits at its own depth.
 * Folder workspaces under a group sit one level below it; a project's cards keep the project's depth
 * because their surface already starts left of the project's icon.
 */
export function getIndentGuideLevels(
  rows: readonly RenderRow[],
  groupBy: WorktreeGroupBy
): number[] {
  let ownedRowLevels = 0
  return rows.map((row) => {
    if (row.type !== 'host-header' && row.type !== 'header') {
      return ownedRowLevels
    }
    if (!isProjectHierarchyHeader(row, groupBy)) {
      ownedRowLevels = 0
      return 0
    }
    const depth = row.projectGroupDepth ?? 0
    ownedRowLevels = row.repo === undefined ? depth + 1 : depth
    return depth
  })
}

/** Vertical runs to draw for the measured rows: one per level per unbroken stretch of nested rows. */
export function getIndentGuideSegments(
  levels: readonly number[],
  measuredRows: readonly MeasuredRow[]
): IndentGuideSegment[] {
  const segments: IndentGuideSegment[] = []
  const open = new Map<number, IndentGuideSegment>()
  let previousIndex: number | null = null
  for (const row of measuredRows) {
    const rowLevels = levels[row.index] ?? 0
    // Why: virtual items skip nothing in order, but a gap means unmeasured rows; never bridge it.
    const contiguous = previousIndex !== null && row.index === previousIndex + 1
    for (const [level, segment] of open) {
      if (level >= rowLevels || !contiguous) {
        segments.push(segment)
        open.delete(level)
      }
    }
    for (let level = 0; level < rowLevels; level++) {
      const segment = open.get(level)
      if (segment) {
        segment.bottom = row.end
      } else {
        open.set(level, { level, top: row.start, bottom: row.end })
      }
    }
    previousIndex = row.index
  }
  segments.push(...open.values())
  return segments
}
