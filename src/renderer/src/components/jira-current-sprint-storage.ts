// Device-local, like the Jira view mode, rather than synced through ui.set.
const STORAGE_KEY = 'orca.jira.current-sprint.v1'

export function loadJiraCurrentSprint(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveJiraCurrentSprint(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(STORAGE_KEY, 'true')
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // The filter stays usable when device storage is unavailable.
  }
}
