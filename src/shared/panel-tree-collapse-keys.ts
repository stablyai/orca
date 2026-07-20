import type { PanelTreeGroup } from './types'

/**
 * Migrate legacy fold keys that stored group *titles* into group.id keys.
 * Returns null when no rewrite is needed.
 */
export function migrateCollapsedPanelGroupKeys(
  groups: readonly PanelTreeGroup[],
  keys: readonly string[],
  rootFoldKey: string
): string[] | null {
  if (groups.length === 0 || keys.length === 0) {
    return null
  }
  const titleToId = new Map(groups.map((g) => [g.title, g.id]))
  const groupIds = new Set(groups.map((g) => g.id))
  let changed = false
  const next: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    if (groupIds.has(key) || key === rootFoldKey) {
      if (!seen.has(key)) {
        seen.add(key)
        next.push(key)
      }
      continue
    }
    const mapped = titleToId.get(key)
    if (mapped) {
      changed = true
      if (!seen.has(mapped)) {
        seen.add(mapped)
        next.push(mapped)
      }
      continue
    }
    if (!seen.has(key)) {
      seen.add(key)
      next.push(key)
    }
  }
  if (!changed) {
    return null
  }
  return next.sort()
}
