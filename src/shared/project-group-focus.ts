import { getProjectGroupSubtreeIds } from './project-groups'
import type { ProjectGroup } from './project-group-types'

/** Resolve a persisted focus id against the live catalog; missing groups clear the focus. */
export function resolveFocusedProjectGroupId(
  groups: readonly Pick<ProjectGroup, 'id'>[],
  focusedProjectGroupId: string | null | undefined
): string | null {
  if (typeof focusedProjectGroupId !== 'string' || focusedProjectGroupId.length === 0) {
    return null
  }
  return groups.some((group) => group.id === focusedProjectGroupId) ? focusedProjectGroupId : null
}

/** Persist/hydrate seam: keep only a non-empty string id. */
export function sanitizeFocusedProjectGroupId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Subtree ids for the focused client/group, or null when the sidebar should show every group.
 * Nested focus still works: the focused node becomes a synthetic root once parents are filtered out.
 */
export function getFocusedProjectGroupSubtreeIds(
  groups: readonly Pick<ProjectGroup, 'id' | 'parentGroupId'>[],
  focusedProjectGroupId: string | null | undefined
): Set<string> | null {
  const resolved = resolveFocusedProjectGroupId(groups, focusedProjectGroupId)
  if (!resolved) {
    return null
  }
  return getProjectGroupSubtreeIds(groups, resolved)
}

export function isMembershipInFocusedProjectGroup(
  projectGroupId: string | null | undefined,
  focusedSubtreeIds: Set<string> | null
): boolean {
  if (!focusedSubtreeIds) {
    return true
  }
  return typeof projectGroupId === 'string' && focusedSubtreeIds.has(projectGroupId)
}

export function filterProjectGroupsForFocus(
  groups: readonly ProjectGroup[],
  focusedSubtreeIds: Set<string> | null
): readonly ProjectGroup[] {
  if (!focusedSubtreeIds) {
    return groups
  }
  return groups.filter((group) => focusedSubtreeIds.has(group.id))
}
