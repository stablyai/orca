import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'

export type IndentGuideSegment = {
  key: string
  level: number
  top: number
  bottom: number
  active: boolean
}

type MeasuredRow = { index: number; start: number; end: number }

// Why: notices keep their own fixed padding, so a guide would cross their text.
const ROWS_WITHOUT_GUIDES = new Set<RenderRow['type']>([
  'pending-creation',
  'imported-worktrees-card',
  'new-external-worktrees-inbox'
])

/**
 * The headers each row sits under, outermost first; one guide per entry. Only project grouping
 * is a tree: there every header (group, project, Pinned) parents the rows up to the next header at
 * its depth or shallower.
 */
export function getIndentGuideAncestors(
  rows: readonly RenderRow[],
  groupBy: WorktreeGroupBy
): string[][] {
  if (groupBy !== 'repo') {
    return rows.map(() => [])
  }
  let open: { key: string; depth: number }[] = []
  return rows.map((row) => {
    if (row.type === 'host-header') {
      open = []
      return []
    }
    if (row.type === 'header') {
      const depth = row.projectGroupDepth ?? 0
      open = open.filter((header) => header.depth < depth)
      const ancestors = open.map((header) => header.key)
      open = [...open, { key: `${row.hostId ?? ''}:${row.key}`, depth }]
      return ancestors
    }
    return ROWS_WITHOUT_GUIDES.has(row.type) ? [] : open.map((header) => header.key)
  })
}

/** Vertical runs for the measured rows: one per header per unbroken stretch of rows under it. */
export function getIndentGuideSegments(
  ancestorsByIndex: readonly (readonly string[])[],
  measuredRows: readonly MeasuredRow[],
  activeAncestors: ReadonlySet<string>
): IndentGuideSegment[] {
  const segments: IndentGuideSegment[] = []
  const open = new Map<number, IndentGuideSegment>()
  let previousIndex: number | null = null
  for (const row of measuredRows) {
    const ancestors = ancestorsByIndex[row.index] ?? []
    // Why: a gap in indices means unmeasured rows between; never bridge it.
    const contiguous = previousIndex !== null && row.index === previousIndex + 1
    for (const [level, segment] of open) {
      if (!contiguous || ancestors[level] !== segment.key) {
        segments.push(segment)
        open.delete(level)
      }
    }
    ancestors.forEach((key, level) => {
      const segment = open.get(level)
      if (segment) {
        segment.bottom = row.end
      } else {
        const active = activeAncestors.has(key)
        open.set(level, { key, level, top: row.start, bottom: row.end, active })
      }
    })
    previousIndex = row.index
  }
  segments.push(...open.values())
  return segments
}
