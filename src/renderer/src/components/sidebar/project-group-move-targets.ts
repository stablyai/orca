import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { compareProjectGroupSiblings } from '../../../../shared/project-groups'
import { createProjectGroupMoveCheck } from '../../../../shared/project-group-nesting'
import {
  catalogOwnsHost,
  getCatalogHostId,
  getProjectGroupHostId
} from '@/store/slices/project-group-owner-routing'

export type ProjectGroupMoveTarget = {
  group: ProjectGroup
  /** Tree depth in sidebar order; top-level groups are 0. */
  depth: number
  disabled: boolean
}

/** Groups stored by the host that owns `hostId`; local and direct-SSH rows share one catalog. */
export function selectProjectGroupCatalog(
  groups: readonly ProjectGroup[],
  hostId: ExecutionHostId
): ProjectGroup[] {
  const catalogHostId = getCatalogHostId(hostId)
  return groups.filter((group) => catalogOwnsHost(catalogHostId, getProjectGroupHostId(group)))
}

// Why: depth-first in sidebar order, so equal names in different branches read apart by indent.
function orderProjectGroupTree(
  catalog: readonly ProjectGroup[]
): { group: ProjectGroup; depth: number }[] {
  const ids = new Set(catalog.map((group) => group.id))
  const childrenByParentId = new Map<string | null, ProjectGroup[]>()
  for (const group of catalog) {
    const parentId =
      group.parentGroupId && ids.has(group.parentGroupId) ? group.parentGroupId : null
    const siblings = childrenByParentId.get(parentId) ?? []
    siblings.push(group)
    childrenByParentId.set(parentId, siblings)
  }
  const ordered: { group: ProjectGroup; depth: number }[] = []
  const visit = (siblings: ProjectGroup[] | undefined, depth: number): void => {
    for (const group of (siblings ?? []).sort(compareProjectGroupSiblings)) {
      ordered.push({ group, depth })
      visit(childrenByParentId.get(group.id), depth + 1)
    }
  }
  visit(childrenByParentId.get(null), 0)
  return ordered
}

/** Same-host groups the group may move under; its own subtree and too-deep targets are left out. */
export function getProjectGroupMoveTargetsForGroup(
  groups: readonly ProjectGroup[],
  movingGroup: ProjectGroup
): ProjectGroupMoveTarget[] {
  const hostId = getProjectGroupHostId(movingGroup)
  const catalog = selectProjectGroupCatalog(groups, hostId)
  const rejectMove = createProjectGroupMoveCheck(catalog, movingGroup.id)
  return orderProjectGroupTree(catalog)
    .filter(({ group }) => getProjectGroupHostId(group) === hostId && rejectMove(group.id) === null)
    .map(({ group, depth }) => ({
      group,
      depth,
      disabled: group.id === movingGroup.parentGroupId
    }))
}

export function getProjectGroupMoveTargetsForProject(
  groups: readonly ProjectGroup[],
  project: Pick<Repo, 'connectionId' | 'executionHostId' | 'projectGroupId'>
): ProjectGroupMoveTarget[] {
  // Why: a host ungroups a project moved to a group it does not hold, so list only its catalog.
  const catalog = selectProjectGroupCatalog(groups, getRepoExecutionHostId(project))
  return orderProjectGroupTree(catalog).map(({ group, depth }) => ({
    group,
    depth,
    disabled: group.id === project.projectGroupId
  }))
}
