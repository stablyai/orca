import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'

export type IndentGuideSegment = {
  key: string
  level: number
  top: number
  bottom: number
  active: boolean
}

export type IndentGuideAncestor = { key: string; level: number }

type MeasuredRow = { index: number; start: number; end: number }

// Why: notices keep their own fixed padding, so a guide would cross their text.
const ROWS_WITHOUT_GUIDES = new Set<RenderRow['type']>([
  'pending-creation',
  'imported-worktrees-card',
  'new-external-worktrees-inbox'
])

/**
 * The headers each row sits under, outermost first; one guide per entry, at its header's depth.
 * Only project grouping is a tree: there every header (group, project, Pinned) parents the rows up
 * to the next header at its depth or shallower.
 */
export function getIndentGuideAncestors(
  rows: readonly RenderRow[],
  groupBy: WorktreeGroupBy
): IndentGuideAncestor[][] {
  if (groupBy !== 'repo') {
    return rows.map(() => [])
  }
  let open: IndentGuideAncestor[] = []
  return rows.map((row) => {
    if (row.type === 'host-header') {
      open = []
      return []
    }
    if (row.type === 'header') {
      // Why: filtered host sections can omit a group's parents, so the level comes from the depth.
      const level = row.projectGroupDepth ?? 0
      open = open.filter((header) => header.level < level)
      const ancestors = open
      open = [...open, { key: `${row.hostId ?? ''}:${row.key}`, level }]
      return ancestors
    }
    return ROWS_WITHOUT_GUIDES.has(row.type) ? [] : open
  })
}

/** Vertical runs for the measured rows: one per header per unbroken stretch of rows under it. */
export function getIndentGuideSegments(
  ancestorsByIndex: readonly (readonly IndentGuideAncestor[])[],
  measuredRows: readonly MeasuredRow[],
  activeAncestors: ReadonlySet<string>
): IndentGuideSegment[] {
  const segments: IndentGuideSegment[] = []
  const open = new Map<string, IndentGuideSegment>()
  let previousIndex: number | null = null
  for (const row of measuredRows) {
    const ancestors = ancestorsByIndex[row.index] ?? []
    // Why: a gap in indices means unmeasured rows between; never bridge it.
    const contiguous = previousIndex !== null && row.index === previousIndex + 1
    for (const [key, segment] of open) {
      if (!contiguous || !ancestors.some((ancestor) => ancestor.key === key)) {
        segments.push(segment)
        open.delete(key)
      }
    }
    for (const { key, level } of ancestors) {
      const segment = open.get(key)
      if (segment) {
        segment.bottom = row.end
      } else {
        const active = activeAncestors.has(key)
        open.set(key, { key, level, top: row.start, bottom: row.end, active })
      }
    }
    previousIndex = row.index
  }
  segments.push(...open.values())
  return segments
}
