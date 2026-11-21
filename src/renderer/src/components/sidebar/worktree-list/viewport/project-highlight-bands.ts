import type { CSSProperties } from 'react'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import { getRenderRowKey, type RenderRow } from '../listing/render-row'
import { resolveProjectGroupHeaderColor } from '../rows/project-header-color'
import { shouldUseHeaderTopSpacing } from './virtual-rows'

const HEADER_TOP_SPACING = 4

export type ProjectHighlightSection = {
  key: string
  color: string
  startIndex: number
  endIndex: number
}

export type ProjectHighlightBand = {
  key: string
  color: string
  top: number
  height: number
}

type RowMeasurement = { start: number; end: number }

export type ProjectHighlightStyle = CSSProperties & Record<'--project-highlight-color', string>

/** Pairs with the `.worktree-project-highlight` class in main.css. */
export function getProjectHighlightStyle(color: string): ProjectHighlightStyle {
  return { '--project-highlight-color': color }
}

export function getProjectHighlightColorForHeader(
  row: RenderRow,
  groupBy: WorktreeGroupBy
): string | undefined {
  if (row.type !== 'header' || row.repo?.sidebarHighlight !== true) {
    return undefined
  }
  return resolveProjectGroupHeaderColor({
    groupBy,
    headerKey: row.key,
    badgeColor: row.repo.badgeColor
  })
}

export function getProjectHighlightHeaderStyle(
  row: RenderRow,
  groupBy: WorktreeGroupBy
): ProjectHighlightStyle | undefined {
  const color = getProjectHighlightColorForHeader(row, groupBy)
  return color ? getProjectHighlightStyle(color) : undefined
}

/** A highlighted project's section runs from its header to the row before the next header. */
export function getProjectHighlightSections(
  rows: readonly RenderRow[],
  groupBy: WorktreeGroupBy
): ProjectHighlightSection[] {
  const sections: ProjectHighlightSection[] = []
  let open: ProjectHighlightSection | null = null
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    if (row.type !== 'header' && row.type !== 'host-header') {
      if (open) {
        open.endIndex = index
      }
      continue
    }
    open = null
    const color = getProjectHighlightColorForHeader(row, groupBy)
    if (color) {
      open = { key: getRenderRowKey(row), color, startIndex: index, endIndex: index }
      sections.push(open)
    }
  }
  return sections
}

export function getProjectHighlightBands(args: {
  sections: readonly ProjectHighlightSection[]
  rows: readonly RenderRow[]
  firstHeaderIndex: number
  measurements: readonly (RowMeasurement | undefined)[]
  visibleStartIndex: number
  visibleEndIndex: number
}): ProjectHighlightBand[] {
  const bands: ProjectHighlightBand[] = []
  for (const section of args.sections) {
    if (section.endIndex < args.visibleStartIndex || section.startIndex > args.visibleEndIndex) {
      continue
    }
    const first = args.measurements[section.startIndex]
    const last = args.measurements[section.endIndex]
    if (!first || !last) {
      continue
    }
    // Why: the header row's pt-1 spacer separates groups, so the band starts below it.
    const top =
      first.start +
      (shouldUseHeaderTopSpacing({
        rows: args.rows,
        index: section.startIndex,
        firstHeaderIndex: args.firstHeaderIndex
      })
        ? HEADER_TOP_SPACING
        : 0)
    const height = last.end - top
    if (height > 0) {
      bands.push({ key: section.key, color: section.color, top, height })
    }
  }
  return bands
}
