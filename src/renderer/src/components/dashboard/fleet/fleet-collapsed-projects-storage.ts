const STORAGE_KEY = 'orca.agentDashboard.fleet.collapsedProjects'
const MAX_COLLAPSED_PROJECTS = 50

function newestKeys(keys: readonly string[]): string[] {
  return keys.slice(-MAX_COLLAPSED_PROJECTS)
}

export function loadFleetCollapsedProjects(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Set(
      Array.isArray(stored)
        ? newestKeys(stored.filter((key): key is string => typeof key === 'string'))
        : []
    )
  } catch {
    return new Set()
  }
}

export function saveFleetCollapsedProjects(keys: ReadonlySet<string>): void {
  try {
    if (keys.size === 0) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newestKeys([...keys])))
    }
  } catch {
    // Collapsed projects still apply for this session when storage is unavailable or full.
  }
}
