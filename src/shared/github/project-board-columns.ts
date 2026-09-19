// Why: board-column derivation is deterministic shared logic driven by
// `selectedView`, kept pure (like github-project-group-sort) so desktop and
// mobile can render Board views identically and it stays unit-testable.
import { groupRowsByField } from './project-group-sort'
import type { GitHubProjectField, GitHubProjectRow, GitHubProjectView } from './project-types'

export type ProjectBoardColumn = {
  /** Stable key for React reconciliation: option id, `raw:<value>`, or the
   *  shared `EMPTY_GROUP_KEY`. */
  key: string
  label: string
  /** GitHub color keyword (e.g. 'GREEN') for single-select options; '' for
   *  every other column, which renders as plain text like a group header. */
  color: string
  rows: GitHubProjectRow[]
}

/** The field whose values become the board columns. GitHub allows grouping a
 *  board by any groupable field, not just single-selects — the fallbacks cover
 *  cached views fetched before `verticalGroupByFields` was queried. */
export function resolveBoardGroupField(view: GitHubProjectView): GitHubProjectField | null {
  const vertical = view.verticalGroupByFields?.[0]
  if (vertical) {
    return vertical
  }
  const singleSelects = view.fields.filter((f) => f.kind === 'single-select')
  return singleSelects.find((f) => f.name === 'Status') ?? singleSelects[0] ?? null
}

/** Board columns are the table's groups laid out horizontally. Single-select
 *  fields additionally get a column per option — including empty ones, in
 *  option order — because that's what github.com renders. */
export function buildBoardColumns(
  field: GitHubProjectField,
  rowsInOrder: GitHubProjectRow[]
): ProjectBoardColumn[] {
  const groups = groupRowsByField(field, rowsInOrder)
  if (field.kind !== 'single-select') {
    return groups.map((g) => ({
      key: g.key,
      label: g.label,
      color: '',
      rows: g.rows
    }))
  }
  const rowsByKey = new Map(groups.map((g) => [g.key, g.rows]))
  const columns: ProjectBoardColumn[] = field.options.map((o) => ({
    key: o.id,
    label: o.name,
    color: o.color,
    rows: rowsByKey.get(o.id) ?? []
  }))
  // Deleted/renamed options and the no-value bucket keep groupRowsByField's
  // trailing order rather than being mislabeled as an existing option.
  const optionIds = new Set(field.options.map((o) => o.id))
  for (const g of groups) {
    if (!optionIds.has(g.key)) {
      columns.push({ key: g.key, label: g.label, color: '', rows: g.rows })
    }
  }
  return columns
}
