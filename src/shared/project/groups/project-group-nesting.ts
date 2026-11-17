import type { ProjectGroup } from './project-group-types'
import {
  buildProjectGroupChildIndex,
  collectProjectGroupSubtreeIds,
  type ProjectGroupChildIndex
} from './project-groups'

/** Top-level groups are level 1. Only manual creates and moves are capped, not folder imports. */
export const MAX_PROJECT_GROUP_LEVELS = 3

export type ProjectGroupNestingNode = Pick<ProjectGroup, 'id' | 'parentGroupId' | 'connectionId'>

export type ProjectGroupMoveRejection =
  | 'group-not-found'
  | 'parent-not-found'
  | 'self'
  | 'descendant'
  | 'host-mismatch'
  | 'too-deep'

function indexProjectGroupsById(
  groups: readonly ProjectGroupNestingNode[]
): Map<string, ProjectGroupNestingNode> {
  return new Map(groups.map((group) => [group.id, group]))
}

function levelInIndex(byId: ReadonlyMap<string, ProjectGroupNestingNode>, groupId: string): number {
  const visited = new Set<string>()
  let group = byId.get(groupId)
  while (group && !visited.has(group.id)) {
    visited.add(group.id)
    group = group.parentGroupId ? byId.get(group.parentGroupId) : undefined
  }
  return visited.size
}

function subtreeLevelsInIndex(childIndex: ProjectGroupChildIndex, groupId: string): number {
  const visited = new Set([groupId])
  let frontier = [groupId]
  let levels = 0
  while (frontier.length > 0) {
    levels += 1
    const next: string[] = []
    for (const id of frontier) {
      for (const childId of childIndex.get(id) ?? []) {
        if (!visited.has(childId)) {
          visited.add(childId)
          next.push(childId)
        }
      }
    }
    frontier = next
  }
  return levels
}

/** 0 for an unknown group; a missing parent counts as top level. */
export function getProjectGroupLevel(
  groups: readonly ProjectGroupNestingNode[],
  groupId: string
): number {
  return levelInIndex(indexProjectGroupsById(groups), groupId)
}

/** Levels the group's subtree spans, counting the group itself (a leaf is 1). */
export function getProjectGroupSubtreeLevels(
  groups: readonly ProjectGroupNestingNode[],
  groupId: string
): number {
  if (!groups.some((group) => group.id === groupId)) {
    return 0
  }
  return subtreeLevelsInIndex(buildProjectGroupChildIndex(groups), groupId)
}

export function canCreateProjectSubgroup(
  groups: readonly ProjectGroupNestingNode[],
  parentGroupId: string
): boolean {
  const level = getProjectGroupLevel(groups, parentGroupId)
  return level > 0 && level < MAX_PROJECT_GROUP_LEVELS
}

/** Indexes the moving group's subtree once, so checking every candidate parent stays linear. */
export function createProjectGroupMoveCheck(
  groups: readonly ProjectGroupNestingNode[],
  groupId: string
): (parentGroupId: string | null) => ProjectGroupMoveRejection | null {
  const byId = indexProjectGroupsById(groups)
  const group = byId.get(groupId)
  if (!group) {
    return () => 'group-not-found'
  }
  const childIndex = buildProjectGroupChildIndex(groups)
  const subtreeIds = collectProjectGroupSubtreeIds(childIndex, groupId)
  const subtreeLevels = subtreeLevelsInIndex(childIndex, groupId)
  const deepestNow = levelInIndex(byId, groupId) - 1 + subtreeLevels
  return (parentGroupId) => {
    if (parentGroupId === null) {
      return null
    }
    if (parentGroupId === groupId) {
      return 'self'
    }
    const parent = byId.get(parentGroupId)
    if (!parent) {
      return 'parent-not-found'
    }
    if (subtreeIds.has(parentGroupId)) {
      return 'descendant'
    }
    if ((parent.connectionId ?? null) !== (group.connectionId ?? null)) {
      return 'host-mismatch'
    }
    const deepestAfterMove = levelInIndex(byId, parentGroupId) + subtreeLevels
    // Why: a move never deepens past the cap, but imported trees already deeper can still move shallower.
    return deepestAfterMove > Math.max(MAX_PROJECT_GROUP_LEVELS, deepestNow) ? 'too-deep' : null
  }
}

export function getProjectGroupMoveRejection(
  groups: readonly ProjectGroupNestingNode[],
  groupId: string,
  parentGroupId: string | null
): ProjectGroupMoveRejection | null {
  return createProjectGroupMoveCheck(groups, groupId)(parentGroupId)
}

export function describeProjectGroupMoveRejection(rejection: ProjectGroupMoveRejection): string {
  switch (rejection) {
    case 'group-not-found':
      return 'Project group not found.'
    case 'parent-not-found':
      return 'Parent project group not found.'
    case 'self':
      return 'A project group cannot be moved into itself.'
    case 'descendant':
      return 'A project group cannot be moved into one of its subgroups.'
    case 'host-mismatch':
      return 'A project group can only be nested in a group on the same host.'
    case 'too-deep':
      return `Project groups can be nested at most ${MAX_PROJECT_GROUP_LEVELS} levels deep.`
  }
}
