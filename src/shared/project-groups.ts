import { normalizeExecutionHostId } from './execution-host'
import type { ProjectGroup, ProjectGroupCreatedFrom } from './project-group-types'
import type { Repo } from './repo-types'
import { createNonSecureContextUuid } from './non-secure-context-uuid'

export const UNGROUPED_PROJECT_GROUP_KEY = 'project-group:ungrouped'

export function normalizeProjectGroupName(name: string, fallback = 'Untitled group'): string {
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

export function createProjectGroup(input: {
  name: string
  parentPath?: string | null
  connectionId?: string | null
  parentGroupId?: string | null
  createdFrom: ProjectGroupCreatedFrom
  tabOrder: number
  now?: number
}): ProjectGroup {
  const now = input.now ?? Date.now()
  return {
    id: createNonSecureContextUuid(),
    name: normalizeProjectGroupName(input.name),
    parentPath: input.parentPath ?? null,
    connectionId: input.connectionId ?? null,
    parentGroupId: input.parentGroupId ?? null,
    createdFrom: input.createdFrom,
    tabOrder: input.tabOrder,
    isCollapsed: false,
    color: null,
    createdAt: now,
    updatedAt: now
  }
}

export function normalizeProjectGroups(value: unknown): ProjectGroup[] {
  if (!Array.isArray(value)) {
    return []
  }
  const groups: ProjectGroup[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {
      continue
    }
    const raw = candidate as Partial<ProjectGroup>
    if (typeof raw.id !== 'string' || seen.has(raw.id)) {
      continue
    }
    seen.add(raw.id)
    const now = Date.now()
    const executionHostId = normalizeExecutionHostId(raw.executionHostId)
    groups.push({
      id: raw.id,
      name: normalizeProjectGroupName(typeof raw.name === 'string' ? raw.name : ''),
      parentPath: typeof raw.parentPath === 'string' ? raw.parentPath : null,
      connectionId:
        typeof raw.connectionId === 'string'
          ? raw.connectionId
          : raw.connectionId === null
            ? null
            : null,
      parentGroupId: typeof raw.parentGroupId === 'string' ? raw.parentGroupId : null,
      createdFrom:
        raw.createdFrom === 'manual' ||
        raw.createdFrom === 'folder-scan' ||
        raw.createdFrom === 'migration'
          ? raw.createdFrom
          : 'manual',
      tabOrder:
        typeof raw.tabOrder === 'number' && Number.isFinite(raw.tabOrder) ? raw.tabOrder : 0,
      isCollapsed: raw.isCollapsed === true,
      color: typeof raw.color === 'string' ? raw.color : null,
      createdAt:
        typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      updatedAt:
        typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
      // Why: runtime-owned groups otherwise look local after persistence reload.
      ...(executionHostId ? { executionHostId } : {})
    })
  }
  groups.sort(compareProjectGroupSiblings)
  for (const group of groups) {
    if (group.parentGroupId === group.id || !seen.has(group.parentGroupId ?? '')) {
      group.parentGroupId = null
    }
  }
  // Why: the sidebar renders from roots, so a parent cycle would hide every group in it.
  breakProjectGroupParentCycles(groups)
  return groups
}

/** Sidebar order among sibling groups: manual tab order, then name. */
export function compareProjectGroupSiblings(
  left: Pick<ProjectGroup, 'tabOrder' | 'name'>,
  right: Pick<ProjectGroup, 'tabOrder' | 'name'>
): number {
  return left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
}

type ProjectGroupParentLink = Pick<ProjectGroup, 'id' | 'parentGroupId'>

/** Cuts each parent cycle at its first member in `groups` order, so every group reaches a root. */
export function breakProjectGroupParentCycles(groups: readonly ProjectGroupParentLink[]): void {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const rankById = new Map(groups.map((group, index) => [group.id, index]))
  const rank = (group: ProjectGroupParentLink): number => rankById.get(group.id) ?? 0
  const reachesRoot = new Set<string>()
  for (const start of groups) {
    const path: ProjectGroupParentLink[] = []
    const onPath = new Set<string>()
    let current = byId.get(start.id)
    while (current && !reachesRoot.has(current.id) && !onPath.has(current.id)) {
      onPath.add(current.id)
      path.push(current)
      current = current.parentGroupId ? byId.get(current.parentGroupId) : undefined
    }
    if (current && onPath.has(current.id)) {
      const cycle = path.slice(path.indexOf(current))
      const cut = cycle.reduce((first, group) => (rank(group) < rank(first) ? group : first))
      cut.parentGroupId = null
    }
    // Why: memoizing walks that reach a root keeps this linear on large catalogs.
    for (const group of path) {
      reachesRoot.add(group.id)
    }
  }
}

export function clearMissingProjectGroupMemberships(repos: Repo[], groups: ProjectGroup[]): Repo[] {
  const groupIds = new Set(groups.map((group) => group.id))
  return repos.map((repo) =>
    repo.projectGroupId && !groupIds.has(repo.projectGroupId)
      ? { ...repo, projectGroupId: null }
      : repo
  )
}

export type ProjectGroupChildIndex = ReadonlyMap<string, string[]>

/** Build once and reuse when collecting subtrees for more than one root. */
export function buildProjectGroupChildIndex(
  groups: readonly Pick<ProjectGroup, 'id' | 'parentGroupId'>[]
): ProjectGroupChildIndex {
  const childGroupsByParentId = new Map<string, string[]>()
  for (const group of groups) {
    if (!group.parentGroupId) {
      continue
    }
    const children = childGroupsByParentId.get(group.parentGroupId) ?? []
    children.push(group.id)
    childGroupsByParentId.set(group.parentGroupId, children)
  }
  return childGroupsByParentId
}

export function getProjectGroupSubtreeIds(
  groups: readonly Pick<ProjectGroup, 'id' | 'parentGroupId'>[],
  rootGroupId: string
): Set<string> {
  return collectProjectGroupSubtreeIds(buildProjectGroupChildIndex(groups), rootGroupId)
}

export function collectProjectGroupSubtreeIds(
  childGroupsByParentId: ProjectGroupChildIndex,
  rootGroupId: string
): Set<string> {
  const subtreeIds = new Set<string>()
  const pending = [rootGroupId]
  while (pending.length > 0) {
    const groupId = pending.pop()!
    if (subtreeIds.has(groupId)) {
      continue
    }
    subtreeIds.add(groupId)
    // Why: imported project-group trees can be very wide; `push(...children)`
    // can exceed V8's argument limit while collecting descendants.
    for (const childGroupId of childGroupsByParentId.get(groupId) ?? []) {
      pending.push(childGroupId)
    }
  }
  return subtreeIds
}

/** Manual rank for a project inside a group bucket. Explicit
 *  `projectGroupOrder` wins; otherwise fall back to global repo order so drag
 *  midpoint math and sidebar sorting stay aligned. */
export function getEffectiveProjectGroupManualRank(
  repo: Pick<Repo, 'id' | 'projectGroupOrder'> | undefined,
  repoOrderRankById?: ReadonlyMap<string, number>,
  siblingFallbackIndex?: number
): number {
  if (!repo) {
    return Number.POSITIVE_INFINITY
  }
  const order = repo.projectGroupOrder
  if (typeof order === 'number' && Number.isFinite(order)) {
    return order
  }
  const repoRank = repoOrderRankById?.get(repo.id)
  if (repoRank !== undefined) {
    return repoRank * 1000
  }
  if (siblingFallbackIndex !== undefined) {
    return siblingFallbackIndex * 1000
  }
  return Number.POSITIVE_INFINITY
}

export function getNextProjectGroupOrder(repos: readonly Repo[], groupId: string | null): number {
  let max = -1
  for (const repo of repos) {
    if ((repo.projectGroupId ?? null) !== groupId) {
      continue
    }
    const order = repo.projectGroupOrder
    if (typeof order === 'number' && Number.isFinite(order)) {
      max = Math.max(max, order)
    }
  }
  return max + 1
}
