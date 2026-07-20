// Why: column widths are a renderer-only preference. Persisted in
// localStorage (not settings) for the same reasons hidden columns are —
// purely cosmetic per device and a noisy debounced settings write would
// be wasteful for what is effectively continuous drag feedback.
//
// Stored values are interpreted as `fr` weights, not pixels — this lets
// the grid always fit its container exactly. Resize redistributes
// weights between a column pair so the total stays constant and the
// table never grows beyond its container.
import type { GitHubProjectField } from '../../../../shared/github-project-types'

const STORAGE_KEY = 'orca.githubProject.columnWidths'

// Default fr weights — TITLE gets the most room; others sit at a
// comfortable label-width. The numeric values are arbitrary ratios.
export const DEFAULT_TITLE_WIDTH = 360
export const DEFAULT_FIELD_WIDTH = 140
export const ACTION_COLUMN_WIDTH = 80
export const MIN_COLUMN_WIDTH = 60

// Why: SUB_ISSUES_PROGRESS renders a fixed-width bar *and* a
// "completed/total" counter side by side (see ProjectCell.tsx) — the
// generic 60px floor clips the counter behind the bar for any project
// with real sub-issue data. A higher floor here keeps the counter
// visible while still letting users shrink it manually if they want.
export const MIN_COLUMN_WIDTH_BY_DATA_TYPE: Readonly<Record<string, number>> = {
  SUB_ISSUES_PROGRESS: 96
}

export function minColumnWidthFor(field: GitHubProjectField): number {
  return MIN_COLUMN_WIDTH_BY_DATA_TYPE[field.dataType] ?? MIN_COLUMN_WIDTH
}

type WidthMap = Record<string, Record<string, number>>

function readMap(): WidthMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as WidthMap) : {}
  } catch {
    return {}
  }
}

function writeMap(map: WidthMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage may be disabled — widths just won't persist this session.
  }
}

export function loadColumnWidths(scopeKey: string): Readonly<Record<string, number>> {
  const map = readMap()
  return map[scopeKey] ?? {}
}

export function saveColumnWidths(scopeKey: string, widths: Record<string, number>): void {
  const map = readMap()
  if (Object.keys(widths).length === 0) {
    delete map[scopeKey]
  } else {
    map[scopeKey] = widths
  }
  writeMap(map)
}

export function defaultWidthFor(field: GitHubProjectField): number {
  return field.dataType === 'TITLE' ? DEFAULT_TITLE_WIDTH : DEFAULT_FIELD_WIDTH
}

export function resolveWidth(
  field: GitHubProjectField,
  widths: Readonly<Record<string, number>>
): number {
  const stored = widths[field.id]
  const floor = minColumnWidthFor(field)
  if (typeof stored === 'number' && stored >= floor) {
    return stored
  }
  return defaultWidthFor(field)
}

// Why: single source of truth for the project table's grid-template-columns
// — ProjectViewList's header row and ProjectRow's data rows must compute
// identical column tracks or cells drift out of alignment. The first two
// columns are frozen during horizontal scroll, so their widths must be
// deterministic pixels (not a `minmax` range) for the sticky offset math.
export function buildProjectGridTemplate(
  fields: GitHubProjectField[],
  widths: Readonly<Record<string, number>>
): string {
  const cols = fields.map((field, index) =>
    index < 2
      ? `${resolveWidth(field, widths)}px`
      : `minmax(${minColumnWidthFor(field)}px, ${resolveWidth(field, widths)}fr)`
  )
  cols.push(`${ACTION_COLUMN_WIDTH}px`)
  return cols.join(' ')
}
