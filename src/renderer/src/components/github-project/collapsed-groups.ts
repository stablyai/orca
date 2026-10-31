// Why: group collapse is a renderer-only viewing preference — GitHub's view
// definition is the source of truth for rows and grouping, and we layer a
// local collapse state on top. Persisted in localStorage (not settings)
// because it's purely cosmetic per device and would otherwise bloat the
// debounced settings write on every header click.

export const STORAGE_KEY = 'orca.githubProject.collapsedGroups'

type CollapsedMap = Record<string, string[]>

function readMap(): CollapsedMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, value]) => Array.isArray(value) && value.every((item) => typeof item === 'string')
      )
    ) as CollapsedMap
  } catch {
    return {}
  }
}

function writeMap(map: CollapsedMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage may be disabled — collapse just won't persist this session.
  }
}

export function loadCollapsedGroups(scopeKey: string): ReadonlySet<string> {
  const map = readMap()
  return new Set(map[scopeKey] ?? [])
}

export function saveCollapsedGroups(scopeKey: string, collapsed: ReadonlySet<string>): void {
  const map = readMap()
  if (collapsed.size === 0) {
    delete map[scopeKey]
  } else {
    map[scopeKey] = Array.from(collapsed)
  }
  writeMap(map)
}
