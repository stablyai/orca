import { MAX_MANUAL_PROJECT_GROUP_DEPTH } from './project-groups'
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

export type ProjectGroupReparentIndex = {
  /** The dragged group plus all of its descendants. */
  subtreeIds: ReadonlySet<string>
  validate: ProjectGroupReparentValidator
}

/** Precomputes the dragged group's subtree, height, and a memoized ancestor
 *  index in one catalog pass so repeated target checks walk one parent chain
 *  instead of rescanning the whole catalog on every frame. */
export function createProjectGroupReparentIndex(
  groups: Iterable<Pick<ProjectGroup, 'id' | 'parentGroupId'>>,
  groupId: string
): ProjectGroupReparentIndex {
  const parentById = new Map<string, string | null>()
  const childrenByParentId = new Map<string, string[]>()
  for (const group of groups) {
    parentById.set(group.id, group.parentGroupId ?? null)
    if (group.parentGroupId) {
      const children = childrenByParentId.get(group.parentGroupId) ?? []
      children.push(group.id)
      childrenByParentId.set(group.parentGroupId, children)
    }
  }
  if (!parentById.has(groupId)) {
    return { subtreeIds: new Set([groupId]), validate: () => 'missing-group' }
  }

  const subtreeIds = new Set<string>([groupId])
  const pending = [{ id: groupId, height: 0 }]
  let subtreeHeight = 0
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index]!
    for (const childId of childrenByParentId.get(current.id) ?? []) {
      if (subtreeIds.has(childId)) {
        continue
      }
      const height = current.height + 1
      subtreeIds.add(childId)
      subtreeHeight = Math.max(subtreeHeight, height)
      pending.push({ id: childId, height })
    }
  }

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
      current = parent && parentById.has(parent) ? parent : undefined
    }
    if (current !== undefined && onPath.has(current)) {
      // Why: a cyclic chain has no reusable absolute depths; caching them
      // would make validation depend on which target was queried first.
      return path.length
    }
    let depth = current !== undefined ? depthById.get(current)! : 0
    for (let index = path.length - 1; index >= 0; index -= 1) {
      depth += 1
      depthById.set(path[index]!, depth)
    }
    return depthById.get(startId)!
  }
  const validate: ProjectGroupReparentValidator = (parentGroupId) => {
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
  return { subtreeIds, validate }
}

export function createProjectGroupReparentValidator(
  groups: Iterable<Pick<ProjectGroup, 'id' | 'parentGroupId'>>,
  groupId: string
): ProjectGroupReparentValidator {
  return createProjectGroupReparentIndex(groups, groupId).validate
}

/** Preflight/authoritative check shared by renderer drop targeting and the
 *  main-process update path. `null` parent (move to root) is always valid. */
export function getProjectGroupReparentViolation(
  groups: Iterable<Pick<ProjectGroup, 'id' | 'parentGroupId'>>,
  groupId: string,
  parentGroupId: string | null
): ProjectGroupReparentViolation | null {
  return createProjectGroupReparentValidator(groups, groupId)(parentGroupId)
}
