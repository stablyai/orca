import {
  buildProjectGroupChildIndex,
  getProjectGroupDepth
} from '../../../../shared/project-groups'
import type { ProjectGroup } from '../../../../shared/project-group-types'

/** Indent nested client names in menus so hierarchy is scannable. */
export function formatProjectGroupMenuLabel(
  group: Pick<ProjectGroup, 'id' | 'name' | 'parentGroupId'>,
  groupsById: ReadonlyMap<string, Pick<ProjectGroup, 'id' | 'parentGroupId'>>
): string {
  const depth = getProjectGroupDepth(groupsById, group.id)
  if (depth <= 0) {
    return group.name
  }
  return `${'\u00A0'.repeat(depth * 2)}${'› '.repeat(depth)}${group.name}`
}

/** Parents then children in sidebar tabOrder — keeps Move/Focus menus readable. */
export function flattenProjectGroupsForMenu(groups: readonly ProjectGroup[]): ProjectGroup[] {
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const childrenByParent = buildProjectGroupChildIndex(groups)
  const roots = groups
    .filter((group) => !group.parentGroupId || !groupsById.has(group.parentGroupId))
    .slice()
    .sort((left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name))

  const ordered: ProjectGroup[] = []
  const visited = new Set<string>()
  const visit = (groupId: string): void => {
    const group = groupsById.get(groupId)
    if (!group || visited.has(group.id)) {
      return
    }
    visited.add(group.id)
    ordered.push(group)
    const childIds = (childrenByParent.get(groupId) ?? []).slice().sort((leftId, rightId) => {
      const left = groupsById.get(leftId)
      const right = groupsById.get(rightId)
      if (!left || !right) {
        return leftId.localeCompare(rightId)
      }
      return left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
    })
    for (const childId of childIds) {
      visit(childId)
    }
  }
  for (const root of roots) {
    visit(root.id)
  }
  return ordered
}
