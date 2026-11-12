import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  getDistinctProjectGroups,
  getProjectGroupSubtreeIds
} from '../../../../../../shared/project-groups'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  compareCodePoints,
  compareSidebarText
} from '../../../../../../shared/sidebar-list/text-order'
import {
  getRuntimeTargetHostId,
  ipcOrRuntimeTargetForHostId
} from '@/runtime/rpc/targets/runtime-client-target'

export type ProjectGroupMenuEntry = {
  group: ProjectGroup
  depth: number
  disabled: boolean
  pathLabel: string
}

function getSameCatalogHostProjectGroups(
  hostId: ExecutionHostId,
  projectGroups: readonly ProjectGroup[]
): ProjectGroup[] {
  const target = ipcOrRuntimeTargetForHostId(hostId)
  if (!target) {
    return []
  }
  const catalogHostId = getRuntimeTargetHostId(target)
  return getDistinctProjectGroups(
    projectGroups.filter((group) => {
      const groupCatalog = ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(group))
      return groupCatalog !== null && getRuntimeTargetHostId(groupCatalog) === catalogHostId
    })
  )
}

function buildOrderedGroupMenuTree(
  candidates: readonly ProjectGroup[],
  currentGroupId: string | null
): ProjectGroupMenuEntry[] {
  const byId = new Map(candidates.map((group) => [group.id, group]))
  const childrenByParent = new Map<string | null, ProjectGroup[]>()
  for (const group of candidates) {
    const parentId =
      group.parentGroupId && byId.has(group.parentGroupId) ? group.parentGroupId : null
    const list = childrenByParent.get(parentId) ?? []
    list.push(group)
    childrenByParent.set(parentId, list)
  }
  for (const list of childrenByParent.values()) {
    list.sort(
      (left, right) =>
        left.tabOrder - right.tabOrder ||
        compareSidebarText(left.name, right.name) ||
        compareCodePoints(left.id, right.id)
    )
  }

  const selectableSubtreeById = new Map<string, boolean>()
  const computing = new Set<string>()
  const hasSelectableSubtree = (group: ProjectGroup): boolean => {
    const cached = selectableSubtreeById.get(group.id)
    if (cached !== undefined) {
      return cached
    }
    if (computing.has(group.id)) {
      return false
    }
    computing.add(group.id)
    const childSelectable = (childrenByParent.get(group.id) ?? []).some((child) =>
      hasSelectableSubtree(child)
    )
    const value = group.id !== currentGroupId || childSelectable
    computing.delete(group.id)
    selectableSubtreeById.set(group.id, value)
    return value
  }

  const result: ProjectGroupMenuEntry[] = []
  const visited = new Set<string>()
  const visit = (group: ProjectGroup, depth: number, ancestorNames: readonly string[]): void => {
    if (visited.has(group.id) || !hasSelectableSubtree(group)) {
      return
    }
    visited.add(group.id)
    const nextPath = [...ancestorNames, group.name]
    result.push({
      group,
      depth,
      disabled: group.id === currentGroupId,
      pathLabel: nextPath.join(' / ')
    })
    for (const child of childrenByParent.get(group.id) ?? []) {
      visit(child, depth + 1, nextPath)
    }
  }
  for (const root of childrenByParent.get(null) ?? []) {
    visit(root, 0, [])
  }
  return result
}

export function buildJoinableProjectGroupMenuEntries(
  repo: Repo,
  projectGroups: readonly ProjectGroup[]
): ProjectGroupMenuEntry[] {
  const joinable = getSameCatalogHostProjectGroups(getRepoExecutionHostId(repo), projectGroups)
  return buildOrderedGroupMenuTree(joinable, repo.projectGroupId ?? null)
}

export function findJoinableParentGroupForRepo(
  repo: Repo,
  projectGroups: readonly ProjectGroup[]
): ProjectGroup | null {
  if (!repo.projectGroupId) {
    return null
  }
  const joinable = getSameCatalogHostProjectGroups(getRepoExecutionHostId(repo), projectGroups)
  const byId = new Map(joinable.map((group) => [group.id, group]))
  const currentGroup = byId.get(repo.projectGroupId)
  if (!currentGroup?.parentGroupId) {
    return null
  }
  return byId.get(currentGroup.parentGroupId) ?? null
}

function resolveGroupMenuOwnerHostId(
  groupId: string,
  hostId: ExecutionHostId | undefined,
  projectGroups: readonly ProjectGroup[]
): ExecutionHostId {
  if (hostId) {
    return hostId
  }
  const match = projectGroups.find((group) => group.id === groupId)
  return match ? getRepoExecutionHostId(match) : 'local'
}

function getSameExecutionHostProjectGroups(
  hostId: ExecutionHostId,
  projectGroups: readonly ProjectGroup[]
): ProjectGroup[] {
  if (!ipcOrRuntimeTargetForHostId(hostId)) {
    return []
  }
  return getDistinctProjectGroups(
    projectGroups.filter((group) => getRepoExecutionHostId(group) === hostId)
  )
}

export function buildReparentableProjectGroupMenuEntries(
  groupId: string,
  hostId: ExecutionHostId | undefined,
  projectGroups: readonly ProjectGroup[]
): ProjectGroupMenuEntry[] {
  const ownerHostId = resolveGroupMenuOwnerHostId(groupId, hostId, projectGroups)
  const sameHost = getSameExecutionHostProjectGroups(ownerHostId, projectGroups)
  const byId = new Map(sameHost.map((group) => [group.id, group]))
  const currentGroup = byId.get(groupId)
  if (!currentGroup) {
    return []
  }
  const subtreeIds = getProjectGroupSubtreeIds(sameHost, groupId)
  const candidates = sameHost.filter((group) => !subtreeIds.has(group.id))
  const currentParentGroupId =
    currentGroup.parentGroupId && byId.has(currentGroup.parentGroupId)
      ? currentGroup.parentGroupId
      : null
  return buildOrderedGroupMenuTree(candidates, currentParentGroupId)
}

export function resolveProjectGroupParentMenuTargets(
  groupId: string,
  hostId: ExecutionHostId | undefined,
  projectGroups: readonly ProjectGroup[]
): {
  isNested: boolean
  grandparentGroup: ProjectGroup | null
} {
  const ownerHostId = resolveGroupMenuOwnerHostId(groupId, hostId, projectGroups)
  const sameHost = getSameExecutionHostProjectGroups(ownerHostId, projectGroups)
  const byId = new Map(sameHost.map((group) => [group.id, group]))
  const currentGroup = byId.get(groupId)
  const parentGroup = currentGroup?.parentGroupId
    ? (byId.get(currentGroup.parentGroupId) ?? null)
    : null
  if (!parentGroup) {
    return { isNested: false, grandparentGroup: null }
  }
  const grandparentGroup = parentGroup.parentGroupId
    ? (byId.get(parentGroup.parentGroupId) ?? null)
    : null
  return { isNested: true, grandparentGroup }
}
