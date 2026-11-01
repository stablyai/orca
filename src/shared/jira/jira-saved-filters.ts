import { isUtf8ByteLengthWithinLimit } from '../utf8-byte-limits'
export const MAX_JIRA_SAVED_FILTERS = 50
export const MAX_JIRA_SAVED_FILTER_ID_LENGTH = 128
export const MAX_JIRA_SAVED_FILTER_NAME_LENGTH = 80
export const MAX_JIRA_SAVED_FILTER_JQL_LENGTH = 8 * 1024

export type JiraSavedFilter = {
  id: string
  name: string
  jql: string
}

function normalizeBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength) {
    return null
  }
  return normalized
}

export function normalizeJiraSavedFilters(value: unknown): JiraSavedFilter[] {
  if (!Array.isArray(value)) {
    return []
  }

  const normalized: JiraSavedFilter[] = []
  const ids = new Set<string>()
  const names = new Set<string>()

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue
    }
    if (!('id' in candidate) || !('name' in candidate) || !('jql' in candidate)) {
      continue
    }
    const input = candidate
    const id = normalizeBoundedString(input.id, MAX_JIRA_SAVED_FILTER_ID_LENGTH)
    const name = normalizeBoundedString(input.name, MAX_JIRA_SAVED_FILTER_NAME_LENGTH)
    const jql = normalizeBoundedString(input.jql, MAX_JIRA_SAVED_FILTER_JQL_LENGTH)
    if (
      !id ||
      !name ||
      !jql ||
      !isUtf8ByteLengthWithinLimit(jql, MAX_JIRA_SAVED_FILTER_JQL_LENGTH)
    ) {
      continue
    }

    const normalizedName = name.toLowerCase()
    if (ids.has(id) || names.has(normalizedName)) {
      continue
    }

    normalized.push({ id, name, jql })
    ids.add(id)
    names.add(normalizedName)
    if (normalized.length === MAX_JIRA_SAVED_FILTERS) {
      break
    }
  }

  return normalized
}

export type JiraSavedFilterState = {
  filters: JiraSavedFilter[]
  activeFilterId: string | null
}

export type JiraSavedFilterMutation =
  | { kind: 'save'; filter: JiraSavedFilter }
  | { kind: 'delete'; id: string }
  | { kind: 'select'; id: string | null }

export function normalizeJiraSavedFilterState(value: unknown): JiraSavedFilterState {
  if (!value || typeof value !== 'object' || !('filters' in value)) {
    return { filters: [], activeFilterId: null }
  }
  const filters = normalizeJiraSavedFilters(value.filters)
  const activeFilterId =
    'activeFilterId' in value &&
    typeof value.activeFilterId === 'string' &&
    filters.some((filter) => filter.id === value.activeFilterId)
      ? value.activeFilterId
      : null
  return { filters, activeFilterId }
}

export function mutateJiraSavedFilterState(
  value: unknown,
  mutation: JiraSavedFilterMutation
): JiraSavedFilterState {
  const state = normalizeJiraSavedFilterState(value)
  if (mutation.kind === 'select') {
    if (mutation.id !== null && !state.filters.some((filter) => filter.id === mutation.id)) {
      throw new Error('Saved Jira filter no longer exists.')
    }
    return { ...state, activeFilterId: mutation.id }
  }
  if (mutation.kind === 'delete') {
    return {
      filters: state.filters.filter((filter) => filter.id !== mutation.id),
      activeFilterId: state.activeFilterId === mutation.id ? null : state.activeFilterId
    }
  }
  const filter = normalizeJiraSavedFilters([mutation.filter])[0]
  if (!filter) {
    throw new Error('Invalid saved Jira filter.')
  }
  const existing = state.filters.some((item) => item.id === filter.id)
  if (!existing && state.filters.length >= MAX_JIRA_SAVED_FILTERS) {
    throw new Error('Saved Jira filter limit reached.')
  }
  if (
    state.filters.some(
      (item) => item.id !== filter.id && item.name.toLowerCase() === filter.name.toLowerCase()
    )
  ) {
    throw new Error('A saved filter with this name already exists.')
  }
  return {
    filters: existing
      ? state.filters.map((item) => (item.id === filter.id ? filter : item))
      : [...state.filters, filter],
    activeFilterId: state.activeFilterId
  }
}
