// Bulk section-level collapse/expand for workspace group lists. Desktop's
// sidebar and mobile's host list share the persisted collapsedGroups set, so
// both toggles live here.
//
// Collapse adds the visible section keys on top of the existing set. Expand
// keeps only keys matching preservedKeyPrefixes — dropping section keys hidden
// inside collapsed parent groups and stale keys from other group modes, while
// row-scoped state (lineage disclosure, host sections) survives untouched.
export function areAllSectionsCollapsed(
  collapsedGroups: ReadonlySet<string>,
  sectionKeys: readonly string[]
): boolean {
  return sectionKeys.length > 0 && sectionKeys.every((key) => collapsedGroups.has(key))
}

export function toggleAllSectionsCollapsed(
  collapsedGroups: ReadonlySet<string>,
  sectionKeys: readonly string[],
  preservedKeyPrefixes: readonly string[]
): string[] {
  if (areAllSectionsCollapsed(collapsedGroups, sectionKeys)) {
    return [...collapsedGroups].filter((key) =>
      preservedKeyPrefixes.some((prefix) => key.startsWith(prefix))
    )
  }
  const next = new Set(collapsedGroups)
  for (const key of sectionKeys) {
    next.add(key)
  }
  return [...next]
}
