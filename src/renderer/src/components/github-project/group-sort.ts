// Why: grouping and sorting of Project rows is deterministic shared logic
// driven by `selectedView` — it must not depend on fetch ordering. Keeping it
// in a pure module makes the comparator easily fixture-testable.
import type {
  GitHubProjectField,
  GitHubProjectRow,
  GitHubProjectSort,
  GitHubProjectTable
} from '../../../../shared/github-project-types'

export type ProjectGroup = {
  /** Stable key used for React reconciliation. */
  key: string
  /** Human-readable label used in the group header. */
  label: string
  /** Iteration metadata for headers that render a date range + Current pill. */
  iteration: {
    startDate: string
    duration: number
    completed: boolean
  } | null
  rows: GitHubProjectRow[]
}

const EMPTY_GROUP_KEY = '__empty__'

// Why: use a finite sentinel instead of Infinity so subtractions in the sort
// comparator stay finite. `Infinity - Infinity` is NaN, which makes
// Array.sort's behavior implementation-defined and skips later tie-breaks.
const UNKNOWN_INDEX_SENTINEL = Number.MAX_SAFE_INTEGER

function getFieldValueForGrouping(
  row: GitHubProjectRow,
  field: GitHubProjectField
): { key: string; label: string; orderHint: number; iteration: ProjectGroup['iteration'] } {
  const value = row.fieldValuesByFieldId[field.id]
  if (!value) {
    return { key: EMPTY_GROUP_KEY, label: labelForEmpty(field), orderHint: UNKNOWN_INDEX_SENTINEL, iteration: null }
  }
  if (field.kind === 'iteration' && value.kind === 'iteration') {
    const idx = field.iterations.findIndex((it) => it.id === value.iterationId)
    const meta = field.iterations.find((it) => it.id === value.iterationId)
    return {
      key: value.iterationId,
      label: value.title || meta?.title || 'Iteration',
      orderHint: idx === -1 ? UNKNOWN_INDEX_SENTINEL - 1 : idx,
      iteration: meta
        ? { startDate: meta.startDate, duration: meta.duration, completed: meta.completed }
        : null
    }
  }
  if (field.kind === 'single-select' && value.kind === 'single-select') {
    const idx = field.options.findIndex((o) => o.id === value.optionId)
    return {
      key: value.optionId,
      label: value.name,
      orderHint: idx === -1 ? UNKNOWN_INDEX_SENTINEL - 1 : idx,
      iteration: null
    }
  }
  // Fallback: use stringified value as both key and label.
  const label = deriveStringValue(value)
  return { key: `raw:${label}`, label, orderHint: 0, iteration: null }
}

function labelForEmpty(field: GitHubProjectField): string {
  return `No ${field.name}`
}

function deriveStringValue(value: GitHubProjectRow['fieldValuesByFieldId'][string]): string {
  switch (value.kind) {
    case 'text':
      return value.text
    case 'number':
      return String(value.number)
    case 'date':
      return value.date
    case 'single-select':
      return value.name
    case 'iteration':
      return value.title
    case 'labels':
      return value.labels.map((l) => l.name).join(', ')
    case 'users':
      return value.users.map((u) => u.login).join(', ')
    default:
      return ''
  }
}

export function groupRows(
  table: GitHubProjectTable,
  rowsInOrder: GitHubProjectRow[]
): ProjectGroup[] {
  const groupField = table.selectedView.groupByFields[0]
  if (!groupField) {
    return [{ key: 'all', label: '', iteration: null, rows: rowsInOrder }]
  }
  const buckets = new Map<
    string,
    { label: string; orderHint: number; iteration: ProjectGroup['iteration']; rows: GitHubProjectRow[] }
  >()
  for (const row of rowsInOrder) {
    const { key, label, orderHint, iteration } = getFieldValueForGrouping(row, groupField)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { label, orderHint, iteration, rows: [] }
      buckets.set(key, bucket)
    }
    bucket.rows.push(row)
  }
  const entries = Array.from(buckets.entries())
  // Ordering rules per design doc §Grouping.
  entries.sort((a, b) => {
    // Empty group always last.
    if (a[0] === EMPTY_GROUP_KEY) {return 1}
    if (b[0] === EMPTY_GROUP_KEY) {return -1}
    if (groupField.kind === 'iteration' || groupField.kind === 'single-select') {
      return a[1].orderHint - b[1].orderHint
    }
    return a[1].label.localeCompare(b[1].label)
  })
  return entries.map(([key, v]) => ({
    key,
    label: v.label,
    iteration: v.iteration,
    rows: v.rows
  }))
}

function compareSort(a: GitHubProjectRow, b: GitHubProjectRow, sort: GitHubProjectSort): number {
  const field = sort.field
  const aValue = a.fieldValuesByFieldId[field.id]
  const bValue = b.fieldValuesByFieldId[field.id]
  // Missing values sort last (regardless of direction).
  if (!aValue && !bValue) {return 0}
  if (!aValue) {return 1}
  if (!bValue) {return -1}

  let cmp = 0
  if (field.kind === 'single-select' && aValue.kind === 'single-select' && bValue.kind === 'single-select') {
    const aIdx = field.options.findIndex((o) => o.id === aValue.optionId)
    const bIdx = field.options.findIndex((o) => o.id === bValue.optionId)
    cmp = (aIdx === -1 ? UNKNOWN_INDEX_SENTINEL : aIdx) - (bIdx === -1 ? UNKNOWN_INDEX_SENTINEL : bIdx)
  } else if (
    field.kind === 'iteration' &&
    aValue.kind === 'iteration' &&
    bValue.kind === 'iteration'
  ) {
    const aIdx = field.iterations.findIndex((it) => it.id === aValue.iterationId)
    const bIdx = field.iterations.findIndex((it) => it.id === bValue.iterationId)
    cmp = (aIdx === -1 ? UNKNOWN_INDEX_SENTINEL : aIdx) - (bIdx === -1 ? UNKNOWN_INDEX_SENTINEL : bIdx)
  } else if (aValue.kind === 'number' && bValue.kind === 'number') {
    cmp = aValue.number - bValue.number
  } else if (aValue.kind === 'date' && bValue.kind === 'date') {
    cmp = aValue.date.localeCompare(bValue.date)
  } else if (aValue.kind === 'text' && bValue.kind === 'text') {
    cmp = aValue.text.localeCompare(bValue.text)
  } else if (aValue.kind === 'users' && bValue.kind === 'users') {
    const aLogin = aValue.users[0]?.login ?? ''
    const bLogin = bValue.users[0]?.login ?? ''
    if (!aLogin && !bLogin) {cmp = 0}
    else if (!aLogin) {cmp = 1}
    else if (!bLogin) {cmp = -1}
    else {cmp = aLogin.localeCompare(bLogin)}
  } else if (aValue.kind === 'labels' && bValue.kind === 'labels') {
    const aName = aValue.labels[0]?.name ?? ''
    const bName = bValue.labels[0]?.name ?? ''
    if (!aName && !bName) {cmp = 0}
    else if (!aName) {cmp = 1}
    else if (!bName) {cmp = -1}
    else {cmp = aName.localeCompare(bName)}
  } else {
    // Why: unknown sort-field kind — ignore this sort field and fall through
    // to tie-breaks (and eventually row.position). Dev-time warning gated so
    // production builds don't spam the console.
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn('[projectView] unknown sort-field kind', field)
    }
    return 0
  }
  return sort.direction === 'DESC' ? -cmp : cmp
}

export function sortRows(
  table: GitHubProjectTable,
  rows: GitHubProjectRow[]
): GitHubProjectRow[] {
  const sorts = table.selectedView.sortByFields
  const out = [...rows]
  out.sort((a, b) => {
    for (const sort of sorts) {
      const cmp = compareSort(a, b, sort)
      if (cmp !== 0) {return cmp}
    }
    // Final tie-break: row.position preserves GitHub rank order.
    return a.position - b.position
  })
  return out
}

export function isIterationCurrent(iteration: {
  startDate: string
  duration: number
}): boolean {
  // Parse as YYYY-MM-DD in UTC to avoid TZ-shift false negatives near midnight.
  const start = new Date(`${iteration.startDate}T00:00:00Z`).getTime()
  if (Number.isNaN(start)) {return false}
  const end = start + iteration.duration * 86_400_000
  const now = Date.now()
  return now >= start && now < end
}
