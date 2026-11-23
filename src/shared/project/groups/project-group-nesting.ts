import type { ProjectGroup } from './project-group-types'
import { buildProjectGroupChildIndex } from './project-groups'

/** Levels a user can build by moving or creating groups; a top-level group is level 1. Folder-scan imports may go deeper. */
export const MAX_PROJECT_GROUP_NESTING_LEVELS = 3

type GroupLink = Pick<ProjectGroup, 'id' | 'parentGroupId'>

/** groupId first, then its parent, up to the top level; stops on a cycle in corrupt data. */
function getProjectGroupAncestry(byId: ReadonlyMap<string, GroupLink>, groupId: string): string[] {
  const ancestry: string[] = []
  for (let group = byId.get(groupId); group && !ancestry.includes(group.id);) {
    ancestry.push(group.id)
    group = group.parentGroupId ? byId.get(group.parentGroupId) : undefined
  }
  return ancestry
}

function getProjectGroupSubtreeHeight(
  childIndex: ReadonlyMap<string, readonly string[]>,
  groupId: string
): number {
  const visited = new Set([groupId])
  let height = 0
  for (let level = [groupId]; level.length > 0; height += 1) {
    level = level.flatMap((id) => childIndex.get(id) ?? []).filter((id) => !visited.has(id))
    level.forEach((id) => visited.add(id))
  }
  return height
}

/** Whether a new subgroup fits under parentGroupId without passing the nesting limit. */
export function canCreateProjectGroupUnder(
  groups: readonly GroupLink[],
  parentGroupId: string
): boolean {
  const byId = new Map(groups.map((group) => [group.id, group]))
  return (
    byId.has(parentGroupId) &&
    getProjectGroupAncestry(byId, parentGroupId).length < MAX_PROJECT_GROUP_NESTING_LEVELS
  )
}

/** Whether groupId (with its subgroups) may move under parentGroupId, or to the top level when null. */
export function canMoveProjectGroup(
  groups: readonly GroupLink[],
  groupId: string,
  parentGroupId: string | null
): boolean {
  const byId = new Map(groups.map((group) => [group.id, group]))
  if (!byId.has(groupId)) {
    return false
  }
  if (parentGroupId === null) {
    return true
  }
  if (!byId.has(parentGroupId)) {
    return false
  }
  const parentAncestry = getProjectGroupAncestry(byId, parentGroupId)
  if (parentAncestry.includes(groupId)) {
    return false
  }
  const height = getProjectGroupSubtreeHeight(buildProjectGroupChildIndex(groups), groupId)
  return parentAncestry.length + height <= MAX_PROJECT_GROUP_NESTING_LEVELS
}
