export function areAllSectionsCollapsed(
  collapsedGroups: ReadonlySet<string>,
  sectionKeys: readonly string[]
): boolean {
  return sectionKeys.length > 0 && sectionKeys.every((key) => collapsedGroups.has(key))
}

export function collapseAllSections(
  collapsedGroups: ReadonlySet<string>,
  sectionKeys: readonly string[]
): string[] {
  const next = new Set(collapsedGroups)
  for (const key of sectionKeys) {
    next.add(key)
  }
  return [...next]
}

// Keeps only keys matching preservedKeyPrefixes (row-scoped state such as lineage
// disclosure and host sections). Section keys hidden inside collapsed parents and
// stale keys from other group modes are cleared with the visible ones.
export function expandAllSections(
  collapsedGroups: ReadonlySet<string>,
  preservedKeyPrefixes: readonly string[]
): string[] {
  return [...collapsedGroups].filter((key) =>
    preservedKeyPrefixes.some((prefix) => key.startsWith(prefix))
  )
}

export function toggleAllSectionsCollapsed(
  collapsedGroups: ReadonlySet<string>,
  sectionKeys: readonly string[],
  preservedKeyPrefixes: readonly string[]
): string[] {
  return areAllSectionsCollapsed(collapsedGroups, sectionKeys)
    ? expandAllSections(collapsedGroups, preservedKeyPrefixes)
    : collapseAllSections(collapsedGroups, sectionKeys)
}
