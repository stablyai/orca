import type { AppState } from '../types'
import type {
  GitHubProjectFieldMutationValue,
  GitHubProjectRow,
  GitHubProjectTable
} from '../../../../shared/github/project-types'

// Why: optimistic field value so the patched row re-renders immediately; best-effort, overwritten by the authoritative payload on next refresh.
export function optimisticFieldValueFromMutation(
  table: GitHubProjectTable,
  fieldId: string,
  value: GitHubProjectFieldMutationValue
): GitHubProjectTable['rows'][number]['fieldValuesByFieldId'][string] | null {
  const field = table.selectedView.fields.find((f) => f.id === fieldId)
  switch (value.kind) {
    case 'single-select': {
      if (field?.kind === 'single-select') {
        const option = field.options.find((o) => o.id === value.optionId)
        if (option) {
          return {
            kind: 'single-select',
            fieldId,
            optionId: option.id,
            name: option.name,
            color: option.color
          }
        }
      }
      return {
        kind: 'single-select',
        fieldId,
        optionId: value.optionId,
        name: '',
        color: ''
      }
    }
    case 'iteration': {
      if (field?.kind === 'iteration') {
        const iteration = field.iterations.find((i) => i.id === value.iterationId)
        if (iteration) {
          return {
            kind: 'iteration',
            fieldId,
            iterationId: iteration.id,
            title: iteration.title,
            startDate: iteration.startDate,
            duration: iteration.duration
          }
        }
      }
      return {
        kind: 'iteration',
        fieldId,
        iterationId: value.iterationId,
        title: '',
        startDate: '',
        duration: 0
      }
    }
    case 'text':
      return { kind: 'text', fieldId, text: value.text }
    case 'number':
      return { kind: 'number', fieldId, number: value.number }
    case 'date':
      return { kind: 'date', fieldId, date: value.date }
  }
  return null
}

export function applyRowPatch(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  cacheKey: string,
  rowId: string,
  nextRow: GitHubProjectRow
): void {
  set((s) => {
    const entry = s.projectViewCache[cacheKey]
    if (!entry?.data) {
      return {}
    }
    const rowIndex = entry.data.rows.findIndex((r) => r.id === rowId)
    if (rowIndex === -1) {
      return {}
    }
    const rows = [...entry.data.rows]
    rows[rowIndex] = nextRow
    return {
      projectViewCache: {
        ...s.projectViewCache,
        [cacheKey]: {
          ...entry,
          data: { ...entry.data, rows }
        }
      }
    }
  })
}

export function rollbackRowIfPresent(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  get: () => AppState,
  cacheKey: string,
  rowId: string,
  previousRow: GitHubProjectRow
): void {
  // Why: skip rollback when the entry moved (rapid project switch) or the row is gone, else stale data would surface in the newly selected project.
  const entry = get().projectViewCache[cacheKey]
  if (!entry?.data) {
    return
  }
  const stillPresent = entry.data.rows.some((r) => r.id === rowId)
  if (!stillPresent) {
    return
  }
  applyRowPatch(set, cacheKey, rowId, previousRow)
}

export function parseSlugAndNumber(
  row: GitHubProjectRow
): { owner: string; repo: string; number: number } | null {
  if (!row.content.repository || row.content.number == null) {
    return null
  }
  const parts = row.content.repository.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }
  return { owner: parts[0], repo: parts[1], number: row.content.number }
}
