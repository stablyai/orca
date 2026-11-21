import { useCallback, useEffect, useMemo, useState } from 'react'

// Why: group collapse is a renderer-only viewing preference — GitHub's view
// definition is the source of truth for rows and grouping, and we layer a
// local collapse state on top. Persisted in localStorage (not settings)
// because it's purely cosmetic per device and would otherwise bloat the
// debounced settings write on every header click.

export const STORAGE_KEY = 'orca.githubProject.collapsedGroups'

type CollapsedMap = Record<string, string[]>

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

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
    const map: CollapsedMap = {}
    for (const [scopeKey, value] of Object.entries(parsed)) {
      if (isStringArray(value)) {
        map[scopeKey] = value
      }
    }
    return map
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

export function useCollapsedGroups(scopeKey: string): {
  collapsed: ReadonlySet<string>
  toggleGroup: (groupKey: string) => void
} {
  const persistedCollapsed = useMemo(() => loadCollapsedGroups(scopeKey), [scopeKey])
  const [collapsedByScope, setCollapsedByScope] = useState<
    Readonly<Record<string, ReadonlySet<string> | undefined>>
  >({})
  const collapsed = collapsedByScope[scopeKey] ?? persistedCollapsed

  useEffect(() => {
    const current = collapsedByScope[scopeKey]
    if (current !== undefined) {
      saveCollapsedGroups(scopeKey, current)
    }
  }, [collapsedByScope, scopeKey])

  const toggleGroup = useCallback(
    (groupKey: string): void => {
      setCollapsedByScope((previous) => {
        const next = new Set(previous[scopeKey] ?? persistedCollapsed)
        if (!next.delete(groupKey)) {
          next.add(groupKey)
        }
        return { ...previous, [scopeKey]: next }
      })
    },
    [persistedCollapsed, scopeKey]
  )

  return { collapsed, toggleGroup }
}
