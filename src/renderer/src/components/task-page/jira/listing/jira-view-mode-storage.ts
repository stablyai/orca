export type JiraViewMode = 'list' | 'board'

// Device-local, like the Jira list columns, rather than synced through ui.set.
const STORAGE_KEY = 'orca.jira.view-mode.v1'

export function loadJiraViewMode(): JiraViewMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'board' ? 'board' : 'list'
  } catch {
    return 'list'
  }
}

export function saveJiraViewMode(mode: JiraViewMode): void {
  try {
    // Storing only the non-default keeps a future default change from being pinned by old devices.
    if (mode === 'board') {
      localStorage.setItem(STORAGE_KEY, 'board')
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // The live view stays usable when browser storage is unavailable or full.
  }
}
