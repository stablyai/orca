import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import {
  getProjectGroupCreateChildRejection,
  getProjectGroupReparentRejection
} from '../../../../../../shared/project-group-reparent'

export type ProjectGroupMoveTarget = {
  group: ProjectGroup
  depth: number
  isCurrentParent: boolean
}

type OrderedProjectGroup = Pick<ProjectGroupMoveTarget, 'group' | 'depth'>

function isSameProjectGroupHost(left: ProjectGroup, right: ProjectGroup): boolean {
  return (left.executionHostId ?? null) === (right.executionHostId ?? null)
}

/** Sidebar order: siblings by tabOrder, depth-first. */
function listProjectGroupsInTreeOrder(groups: readonly ProjectGroup[]): OrderedProjectGroup[] {
  const ids = new Set(groups.map((group) => group.id))
  const childrenByParentId = new Map<string | null, ProjectGroup[]>()
  for (const group of groups) {
    const parentId =
      group.parentGroupId && ids.has(group.parentGroupId) ? group.parentGroupId : null
    const children = childrenByParentId.get(parentId) ?? []
    children.push(group)
    childrenByParentId.set(parentId, children)
  }
  const ordered: OrderedProjectGroup[] = []
  const visited = new Set<string>()
  const visit = (parentId: string | null, depth: number): void => {
    const children = [...(childrenByParentId.get(parentId) ?? [])].sort(
      (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
    )
    for (const child of children) {
      if (visited.has(child.id)) {
        continue
      }
      visited.add(child.id)
      ordered.push({ group: child, depth })
      visit(child.id, depth + 1)
    }
  }
  visit(null, 0)
  return ordered
}

/** Groups `groupId` may be re-parented under: same host, no cycles, within the nesting cap. */
export function getProjectGroupMoveTargets(
  projectGroups: readonly ProjectGroup[],
  groupId: string
): ProjectGroupMoveTarget[] {
  const group = projectGroups.find((entry) => entry.id === groupId)
  if (!group) {
    return []
  }
  // Why: a host only knows its own groups, so cross-host parents would be rejected as missing.
  const hostGroups = projectGroups.filter((entry) => isSameProjectGroupHost(entry, group))
  return listProjectGroupsInTreeOrder(hostGroups)
    .filter(
      ({ group: candidate }) =>
        getProjectGroupReparentRejection(hostGroups, groupId, candidate.id) === null
    )
    .map(({ group: candidate, depth }) => ({
      group: candidate,
      depth,
      isCurrentParent: candidate.id === (group.parentGroupId ?? null)
    }))
}

export function canCreateProjectSubgroup(
  projectGroups: readonly ProjectGroup[],
  groupId: string
): boolean {
  const group = projectGroups.find((entry) => entry.id === groupId)
  if (!group) {
    return false
  }
  const hostGroups = projectGroups.filter((entry) => isSameProjectGroupHost(entry, group))
  return getProjectGroupCreateChildRejection(hostGroups, groupId) === null
}
