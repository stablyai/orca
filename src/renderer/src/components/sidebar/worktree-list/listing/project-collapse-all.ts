import { recordCollapsedGroupChanges } from '@/store/slices/ui/collapsed-group-toggle'
import { isProjectOrPinnedSectionGroupKey } from '../../../../../../shared/sidebar-list/sections/group-keys'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type {
  OccurrenceSectionPath,
  WorktreeOccurrenceSection
} from '../../../../../../shared/sidebar-list/lineage/worktree-occurrence-plan'

export function getOwnedProjectCollapseKeys(
  sections: readonly WorktreeOccurrenceSection<unknown>[]
): string[] {
  const keys = new Set<string>()
  for (const section of sections) {
    let path: OccurrenceSectionPath | undefined = section.revealPath ?? { key: section.key }
    while (path) {
      if (isProjectOrPinnedSectionGroupKey(path.key)) {
        keys.add(path.key)
      }
      path = path.parent
    }
  }
  return [...keys]
}

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

// The caller includes owned nested headers even when their parent is folded.
export function setAllProjectsCollapsed(
  collapsedGroups: ReadonlySet<string>,
  projectKeys: readonly string[],
  collapsed: boolean
): Set<string> {
  const keys = projectKeys
  const next = new Set(collapsedGroups)
  for (const key of keys) {
    if (collapsed) {
      next.add(key)
    } else {
      next.delete(key)
    }
  }
  return recordCollapsedGroupChanges(collapsedGroups, next, keys)
}
