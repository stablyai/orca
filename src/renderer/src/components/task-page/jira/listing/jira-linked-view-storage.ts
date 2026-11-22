const STORAGE_KEY = 'orca.jira.has-workspace.v1'

export function loadJiraLinkedView(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveJiraLinkedView(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(STORAGE_KEY, 'true')
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // The view remains usable when device storage is unavailable.
  }
}
