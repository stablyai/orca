// Why: grouping and sorting of Project rows is deterministic shared logic
// driven by `selectedView` — it must not depend on fetch ordering. Keeping it
// in a pure shared module lets desktop and mobile render Project views the same.
import type {
  GitHubProjectField,
  GitHubProjectRow,
  GitHubProjectSort,
  GitHubProjectTable
} from './project-types'

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

type ProjectFieldValue = GitHubProjectRow['fieldValuesByFieldId'][string]

/** False for anything that renders as an empty cell — absent, or present with a blank payload. */
function hasNonEmptyFieldValue(value: ProjectFieldValue | undefined): boolean {
  if (!value) {
    return false
  }
  switch (value.kind) {
    case 'users':
      return Boolean(value.users[0]?.login)
    case 'labels':
      return Boolean(value.labels[0]?.name)
    case 'text':
      return value.text.trim().length > 0
    case 'date':
      return value.date.trim().length > 0
    case 'iteration':
    case 'number':
    case 'single-select':
      return true
  }
}

// Why: use a finite sentinel instead of Infinity so subtractions in the sort
// comparator stay finite. `Infinity - Infinity` is NaN, which makes
// Array.sort's behavior implementation-defined and skips later tie-breaks.
const UNKNOWN_INDEX_SENTINEL = Number.MAX_SAFE_INTEGER

// Preserve the mobile mirror's fallback for partial ordering metadata.
function getFieldValueForGrouping(
  row: GitHubProjectRow,
  field: GitHubProjectField
): { key: string; label: string; orderHint: number; iteration: ProjectGroup['iteration'] } {
  const value = row.fieldValuesByFieldId[field.id]
  if (!hasNonEmptyFieldValue(value)) {
    return {
      key: EMPTY_GROUP_KEY,
      label: labelForEmpty(field),
      orderHint: UNKNOWN_INDEX_SENTINEL,
      iteration: null
    }
  }
  if (field.kind === 'iteration' && value.kind === 'iteration') {
    const iterations = field.iterations ?? []
    const idx = iterations.findIndex((iteration) => iteration.id === value.iterationId)
    const meta = iterations.find((iteration) => iteration.id === value.iterationId)
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
    const idx = (field.options ?? []).findIndex((option) => option.id === value.optionId)
    return {
      key: value.optionId,
      label: value.name,
      orderHint: idx === -1 ? UNKNOWN_INDEX_SENTINEL - 1 : idx,
      iteration: null
    }
  }
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
    {
      label: string
      orderHint: number
      iteration: ProjectGroup['iteration']
      rows: GitHubProjectRow[]
    }
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
    if (a[0] === EMPTY_GROUP_KEY) {
      return 1
    }
    if (b[0] === EMPTY_GROUP_KEY) {
      return -1
    }
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
  // Why: return before the trailing DESC flip so empty sorts last in both directions.
  const aFilled = hasNonEmptyFieldValue(aValue)
  const bFilled = hasNonEmptyFieldValue(bValue)
  if (!aFilled || !bFilled) {
    return aFilled === bFilled ? 0 : aFilled ? -1 : 1
  }

  let cmp = 0
  if (
    field.kind === 'single-select' &&
    aValue.kind === 'single-select' &&
    bValue.kind === 'single-select'
  ) {
    const options = field.options ?? []
    const aIdx = options.findIndex((option) => option.id === aValue.optionId)
    const bIdx = options.findIndex((option) => option.id === bValue.optionId)
    cmp =
      (aIdx === -1 ? UNKNOWN_INDEX_SENTINEL : aIdx) - (bIdx === -1 ? UNKNOWN_INDEX_SENTINEL : bIdx)
  } else if (
    field.kind === 'iteration' &&
    aValue.kind === 'iteration' &&
    bValue.kind === 'iteration'
  ) {
    const iterations = field.iterations ?? []
    const aIdx = iterations.findIndex((iteration) => iteration.id === aValue.iterationId)
    const bIdx = iterations.findIndex((iteration) => iteration.id === bValue.iterationId)
    cmp =
      (aIdx === -1 ? UNKNOWN_INDEX_SENTINEL : aIdx) - (bIdx === -1 ? UNKNOWN_INDEX_SENTINEL : bIdx)
  } else if (aValue.kind === 'number' && bValue.kind === 'number') {
    cmp = aValue.number - bValue.number
  } else if (aValue.kind === 'date' && bValue.kind === 'date') {
    cmp = aValue.date.localeCompare(bValue.date)
  } else if (aValue.kind === 'text' && bValue.kind === 'text') {
    cmp = aValue.text.localeCompare(bValue.text)
  } else if (aValue.kind === 'users' && bValue.kind === 'users') {
    cmp = (aValue.users[0]?.login ?? '').localeCompare(bValue.users[0]?.login ?? '')
  } else if (aValue.kind === 'labels' && bValue.kind === 'labels') {
    cmp = (aValue.labels[0]?.name ?? '').localeCompare(bValue.labels[0]?.name ?? '')
  } else {
    // Why: unknown sort-field kind — ignore this sort field and fall through
    // to tie-breaks (and eventually row.position).
    return 0
  }
  return sort.direction === 'DESC' ? -cmp : cmp
}

export function sortRows(table: GitHubProjectTable, rows: GitHubProjectRow[]): GitHubProjectRow[] {
  const sorts = table.selectedView.sortByFields
  const out = [...rows]
  out.sort((a, b) => {
    for (const sort of sorts) {
      const cmp = compareSort(a, b, sort)
      if (cmp !== 0) {
        return cmp
      }
    }
    return (a.position ?? UNKNOWN_INDEX_SENTINEL) - (b.position ?? UNKNOWN_INDEX_SENTINEL)
  })
  return out
}

export function isIterationCurrent(iteration: { startDate: string; duration: number }): boolean {
  const start = new Date(`${iteration.startDate}T00:00:00Z`).getTime()
  if (Number.isNaN(start)) {
    return false
  }
  const end = start + iteration.duration * 86_400_000
  const now = Date.now()
  return now >= start && now < end
}
