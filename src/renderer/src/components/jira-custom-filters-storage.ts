import {
  resolveJiraFilterViewState,
  type JiraFilterViewState
} from '../../../shared/jira-custom-filters'

// Why: custom filters are a per-device preference, not host state. Routing them
// through `ui.set` would nest them in taskResumeState's strict schema, where a
// host that predates the field silently discards the WHOLE resume state.
const STORAGE_KEY = 'orca.jira.custom-filters.v1'

export function loadJiraFilterViewState(): JiraFilterViewState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return resolveJiraFilterViewState(raw ? (JSON.parse(raw) as unknown) : undefined)
  } catch {
    return resolveJiraFilterViewState(undefined)
  }
}

export function saveJiraFilterViewState(state: JiraFilterViewState): void {
  try {
    const normalized = resolveJiraFilterViewState(state)
    if (normalized.customFilters.length === 0 && !normalized.activeFilter) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // The live view stays usable when browser storage is unavailable or full.
  }
}
