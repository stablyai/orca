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
  /** undefined is read-only; null clears the field. */
  dropValue: GitHubProjectFieldMutationValue | null | undefined
  rows: GitHubProjectRow[]
}

export function resolveBoardColumnField(view: GitHubProjectView): GitHubProjectField | null {
  const vertical = view.verticalGroupByFields?.[0]
  // Non-select fields must never expose clear-only drop targets.
  if (vertical && (vertical.kind === 'single-select' || vertical.kind === 'iteration')) {
    return vertical
  }
  // Older hosts omit vertical grouping; Status is GitHub's default.
  const singleSelects = view.fields.filter((field) => field.kind === 'single-select')
  return singleSelects.find((field) => /^status$/i.test(field.name)) ?? singleSelects[0] ?? null
}

/** Includes empty options, deleted-option buckets, and a final unset bucket. */
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
  // Preserve deleted options as read-only columns.
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
    dropValue: field.kind === 'single-select' || field.kind === 'iteration' ? null : undefined,
    rows: bucketsByKey.get(EMPTY_PROJECT_GROUP_KEY)?.rows ?? []
  })
  return columns
}
