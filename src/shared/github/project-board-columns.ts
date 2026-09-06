// Why: board columns are deterministic shared logic like grouping — the field
// choice and bucket order must not depend on the renderer, so desktop (and a
// future mobile board) derive identical columns from the same view.
import { EMPTY_PROJECT_GROUP_KEY, groupRowsByField } from './project-group-sort'
import type {
  GitHubProjectField,
  GitHubProjectFieldMutationValue,
  GitHubProjectRow,
  GitHubProjectView
} from './project-types'

export type ProjectBoardColumn = {
  /** Stable key used for React reconciliation. */
  key: string
  label: string
  /** GitHub single-select color token ('GREEN', …) when the column is one. */
  color: string | null
  /** Field mutation that moves a card into this column. `null` clears the
   *  field (the no-value column); `undefined` means the column kind cannot be
   *  a drop target (users/labels/text buckets). */
  dropValue: GitHubProjectFieldMutationValue | null | undefined
  rows: GitHubProjectRow[]
}

export function resolveBoardColumnField(view: GitHubProjectView): GitHubProjectField | null {
  const vertical = view.verticalGroupByFields?.[0]
  if (vertical) {
    return vertical
  }
  // Why: views cached before `verticalGroupByFields` was queried (or hosts
  // whose schema lacks it) still describe a board — GitHub's default board
  // column field is Status, then any single-select carries the same shape.
  const singleSelects = view.fields.filter((field) => field.kind === 'single-select')
  return singleSelects.find((field) => /^status$/i.test(field.name)) ?? singleSelects[0] ?? null
}

/** Builds the column list: every single-select option gets a column in option
 *  order (empty ones included, matching github.com), rows pointing at deleted
 *  options keep their own labeled column, and the no-value column trails. */
export function buildBoardColumns(
  field: GitHubProjectField,
  rowsInOrder: GitHubProjectRow[]
): ProjectBoardColumn[] {
  const buckets = groupRowsByField(field, rowsInOrder)
  const bucketsByKey = new Map(buckets.map((bucket) => [bucket.key, bucket]))
  const columns: ProjectBoardColumn[] = []
  if (field.kind === 'single-select') {
    for (const option of field.options) {
      columns.push({
        key: option.id,
        label: option.name,
        color: option.color || null,
        dropValue: { kind: 'single-select', optionId: option.id },
        rows: bucketsByKey.get(option.id)?.rows ?? []
      })
      bucketsByKey.delete(option.id)
    }
  } else if (field.kind === 'iteration') {
    for (const iteration of field.iterations) {
      columns.push({
        key: iteration.id,
        label: iteration.title,
        color: null,
        dropValue: { kind: 'iteration', iterationId: iteration.id },
        rows: bucketsByKey.get(iteration.id)?.rows ?? []
      })
      bucketsByKey.delete(iteration.id)
    }
  }
  // Remaining buckets: non-select fields entirely, or values whose option or
  // iteration was deleted after assignment — keep them visible, not mislabeled.
  // Why undefined dropValue: there is nothing valid to mutate a card INTO here
  // (a deleted option id would be rejected; users/labels moves are ambiguous).
  for (const bucket of buckets) {
    if (!bucketsByKey.has(bucket.key) || bucket.key === EMPTY_PROJECT_GROUP_KEY) {
      continue
    }
    columns.push({
      key: bucket.key,
      label: bucket.label,
      color: null,
      dropValue: undefined,
      rows: bucket.rows
    })
  }
  columns.push({
    key: EMPTY_PROJECT_GROUP_KEY,
    label: `No ${field.name}`,
    color: null,
    dropValue: null,
    rows: bucketsByKey.get(EMPTY_PROJECT_GROUP_KEY)?.rows ?? []
  })
  return columns
}
