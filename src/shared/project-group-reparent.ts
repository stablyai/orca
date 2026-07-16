import {
  MAX_MANUAL_PROJECT_GROUP_DEPTH,
  getProjectGroupSubtreeHeight,
  getProjectGroupSubtreeIds
} from './project-groups'
import type { ProjectGroup } from './types'

export type ProjectGroupReparentViolation =
  | 'missing-group'
  | 'missing-parent'
  | 'self'
  | 'cycle'
  | 'depth'

export type ProjectGroupReparentValidator = (
  parentGroupId: string | null
) => ProjectGroupReparentViolation | null

/** Precomputes the dragged group's subtree, height, and a memoized ancestor
 *  index so repeated target checks (per-frame drop targeting) walk one parent
 *  chain instead of rescanning the whole catalog on every call. */
export function createProjectGroupReparentValidator(
  groups: readonly Pick<ProjectGroup, 'id' | 'parentGroupId'>[],
  groupId: string
): ProjectGroupReparentValidator {
  const parentById = new Map<string, string | null>()
  for (const group of groups) {
    parentById.set(group.id, group.parentGroupId ?? null)
  }
  if (!parentById.has(groupId)) {
    return () => 'missing-group'
  }
  const subtreeIds = getProjectGroupSubtreeIds(groups, groupId)
  const subtreeHeight = getProjectGroupSubtreeHeight(groups, groupId)
  const depthById = new Map<string, number>()
  const getDepth = (startId: string): number => {
    // Cycle-safe chain walk counting only resolvable ancestors, mirroring
    // getProjectGroupDepth; visited depths memoize across validator calls.
    const path: string[] = []
    const onPath = new Set<string>()
    let current: string | undefined = startId
    while (current !== undefined && !depthById.has(current) && !onPath.has(current)) {
      path.push(current)
      onPath.add(current)
      const parent: string | null = parentById.get(current) ?? null
      current = parent !== null && parentById.has(parent) ? parent : undefined
    }
    let depth = current !== undefined ? (depthById.get(current) ?? 0) : 0
    for (let index = path.length - 1; index >= 0; index -= 1) {
      depth += 1
      depthById.set(path[index]!, depth)
    }
    return depthById.get(startId)!
  }
  return (parentGroupId) => {
    if (parentGroupId === null) {
      return null
    }
    if (parentGroupId === groupId) {
      return 'self'
    }
    if (!parentById.has(parentGroupId)) {
      return 'missing-parent'
    }
    if (subtreeIds.has(parentGroupId)) {
      return 'cycle'
    }
    if (getDepth(parentGroupId) + 1 + subtreeHeight > MAX_MANUAL_PROJECT_GROUP_DEPTH) {
      return 'depth'
    }
    return null
  }
}

/** Preflight/authoritative check shared by renderer drop targeting and the
 *  main-process update path. `null` parent (move to root) is always valid. */
export function getProjectGroupReparentViolation(
  groups: readonly Pick<ProjectGroup, 'id' | 'parentGroupId'>[],
  groupId: string,
  parentGroupId: string | null
): ProjectGroupReparentViolation | null {
  return createProjectGroupReparentValidator(groups, groupId)(parentGroupId)
}
