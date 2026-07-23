// Why: board-column derivation is deterministic shared logic driven by
// `selectedView`, kept pure (like github-project-group-sort) so desktop and
// mobile can render Board views identically and it stays unit-testable.
import type {
  GitHubProjectField,
  GitHubProjectRow,
  GitHubProjectView
} from './github-project-types'

export type ProjectBoardColumn = {
  /** Stable key for React reconciliation: option id or `__none__`. */
  key: string
  label: string
  /** GitHub color keyword (e.g. 'GREEN'); '' for the no-value column. */
  color: string
  rows: GitHubProjectRow[]
}

const NO_VALUE_KEY = '__none__'

type SingleSelectField = Extract<GitHubProjectField, { kind: 'single-select' }>

/** The field whose options become the board columns. GitHub's own boards
 *  always have one (default: Status); the fallbacks cover schema drift and
 *  cached views fetched before `verticalGroupByFields` was queried. */
export function resolveBoardGroupField(view: GitHubProjectView): SingleSelectField | null {
  const vertical = view.verticalGroupByFields?.find(
    (f): f is SingleSelectField => f.kind === 'single-select'
  )
  if (vertical) {
    return vertical
  }
  const singleSelects = view.fields.filter(
    (f): f is SingleSelectField => f.kind === 'single-select'
  )
  return singleSelects.find((f) => f.name === 'Status') ?? singleSelects[0] ?? null
}

/** One column per field option (in option order, even when empty), then any
 *  columns for values whose option no longer exists, then a trailing
 *  "No <field>" column only when some row lacks a value. */
export function buildBoardColumns(
  field: SingleSelectField,
  rowsInOrder: GitHubProjectRow[]
): ProjectBoardColumn[] {
  const columns: ProjectBoardColumn[] = field.options.map((o) => ({
    key: o.id,
    label: o.name,
    color: o.color,
    rows: []
  }))
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const noValue: ProjectBoardColumn = {
    key: NO_VALUE_KEY,
    label: `No ${field.name}`,
    color: '',
    rows: []
  }
  for (const row of rowsInOrder) {
    const value = row.fieldValuesByFieldId[field.id]
    if (!value || value.kind !== 'single-select') {
      noValue.rows.push(row)
      continue
    }
    let column = byKey.get(value.optionId)
    if (!column) {
      // Deleted/renamed option still present on a row: keep it visible in its
      // own trailing column rather than mislabeling it as "No <field>".
      column = { key: value.optionId, label: value.name, color: value.color, rows: [] }
      byKey.set(value.optionId, column)
      columns.push(column)
    }
    column.rows.push(row)
  }
  if (noValue.rows.length > 0) {
    columns.push(noValue)
  }
  return columns
}
