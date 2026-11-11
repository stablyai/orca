import { isProjectOrPinnedSectionGroupKey } from '../../../../../../shared/sidebar-list/group-keys'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'

export function getRenderedProjectCollapseKeys(rows: readonly HostSectionRow[]): string[] {
  const keys = new Set<string>()
  for (const row of rows) {
    if (row.type !== 'header') {
      continue
    }
    const key = row.collapseKey ?? row.key
    if (isProjectOrPinnedSectionGroupKey(key)) {
      keys.add(key)
    }
  }
  return [...keys]
}

export function areAllProjectsCollapsed(
  projectKeys: readonly string[],
  collapsedGroups: ReadonlySet<string>
): boolean {
  return projectKeys.length > 0 && projectKeys.every((key) => collapsedGroups.has(key))
}

// Expanding clears pinned and every project key, including hidden nested projects.
export function setAllProjectsCollapsed(
  collapsedGroups: ReadonlySet<string>,
  projectKeys: readonly string[],
  collapsed: boolean
): Set<string> {
  return collapsed
    ? new Set([...collapsedGroups, ...projectKeys])
    : new Set([...collapsedGroups].filter((key) => !isProjectOrPinnedSectionGroupKey(key)))
}
