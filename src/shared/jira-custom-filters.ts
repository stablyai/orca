// User-defined Jira filters (name + JQL) stored on this device, plus which
// saved/custom filter is active in the Tasks panel. Saved-filter selections
// snapshot name/jql so they can run before the remote list has loaded.
export type JiraCustomFilter = { id: string; name: string; jql: string }

export type ActiveJiraFilterRef =
  | { source: 'custom'; id: string }
  | { source: 'saved'; siteId: string; filterId: string; name: string; jql: string }

export type JiraFilterViewState = {
  customFilters: JiraCustomFilter[]
  activeFilter?: ActiveJiraFilterRef
}

export const MAX_JIRA_CUSTOM_FILTERS = 50

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeJiraCustomFilters(value: unknown): JiraCustomFilter[] {
  if (!Array.isArray(value)) {
    return []
  }
  const filters: JiraCustomFilter[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (filters.length >= MAX_JIRA_CUSTOM_FILTERS) {
      break
    }
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const record = entry as Record<string, unknown>
    const id = asTrimmedString(record.id)
    const name = asTrimmedString(record.name)
    const jql = asTrimmedString(record.jql)
    if (!id || !name || !jql || seen.has(id)) {
      continue
    }
    seen.add(id)
    filters.push({ id, name, jql })
  }
  return filters
}

function normalizeActiveJiraFilter(
  value: unknown,
  customFilters: JiraCustomFilter[]
): ActiveJiraFilterRef | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (record.source === 'custom') {
    const id = asTrimmedString(record.id)
    return id && customFilters.some((filter) => filter.id === id)
      ? { source: 'custom', id }
      : undefined
  }
  if (record.source === 'saved') {
    const siteId = asTrimmedString(record.siteId)
    const filterId = asTrimmedString(record.filterId)
    const name = asTrimmedString(record.name)
    const jql = asTrimmedString(record.jql)
    return siteId && filterId && name && jql
      ? { source: 'saved', siteId, filterId, name, jql }
      : undefined
  }
  return undefined
}

export function resolveJiraFilterViewState(value: unknown): JiraFilterViewState {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const customFilters = normalizeJiraCustomFilters(record.customFilters)
  const activeFilter = normalizeActiveJiraFilter(record.activeFilter, customFilters)
  return activeFilter ? { customFilters, activeFilter } : { customFilters }
}

/** JQL to run for the active filter, or null when it no longer resolves (fall back to presets). */
export function resolveActiveJiraFilterJql(
  active: ActiveJiraFilterRef | null | undefined,
  customFilters: JiraCustomFilter[]
): string | null {
  if (!active) {
    return null
  }
  if (active.source === 'saved') {
    return active.jql
  }
  const match = customFilters.find((filter) => filter.id === active.id)
  return match ? match.jql : null
}
