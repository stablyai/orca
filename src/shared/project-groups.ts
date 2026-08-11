import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { Repo, ProjectGroup, ProjectGroupCreatedFrom } from './types'
import {
  resolveDeclaredFolderScopeOwner,
  resolveProjectGroupOwner
} from './folder-workspace-owner-resolution'

export const UNGROUPED_PROJECT_GROUP_KEY = 'project-group:ungrouped'

function createProjectGroupId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (randomUUID) {
    return randomUUID.call(globalThis.crypto)
  }
  return `project-group-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function normalizeProjectGroupName(name: string, fallback = 'Untitled group'): string {
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function getNormalizedProjectGroupHostId(group: Partial<ProjectGroup>): ExecutionHostId {
  return (
    normalizeExecutionHostId(group.executionHostId) ??
    (group.connectionId ? toSshExecutionHostId(group.connectionId) : LOCAL_EXECUTION_HOST_ID)
  )
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
    id: createProjectGroupId(),
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
    if (typeof raw.id !== 'string') {
      continue
    }
    const hostId = getNormalizedProjectGroupHostId(raw)
    const identity = `${hostId}\0${raw.id}`
    if (seen.has(identity)) {
      continue
    }
    seen.add(identity)
    const now = Date.now()
    const executionHostId = normalizeExecutionHostId(raw.executionHostId)
    groups.push({
      id: raw.id,
      name: normalizeProjectGroupName(typeof raw.name === 'string' ? raw.name : ''),
      parentPath: typeof raw.parentPath === 'string' ? raw.parentPath : null,
      ...(typeof raw.connectionId === 'string' || raw.connectionId === null
        ? { connectionId: raw.connectionId }
        : {}),
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
  groups.sort(
    (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
  )
  const groupIdentities = new Set(
    groups.map((group) => `${getNormalizedProjectGroupHostId(group)}\0${group.id}`)
  )
  for (const group of groups) {
    if (
      group.parentGroupId === group.id ||
      !groupIdentities.has(
        `${getNormalizedProjectGroupHostId(group)}\0${group.parentGroupId ?? ''}`
      )
    ) {
      group.parentGroupId = null
    }
  }
  return groups
}

export function clearMissingProjectGroupMemberships(repos: Repo[], groups: ProjectGroup[]): Repo[] {
  return repos.map((repo) =>
    repo.projectGroupId && !hasProjectGroupForRepoExecutionHost(repo, repo.projectGroupId, groups)
      ? { ...repo, projectGroupId: null }
      : repo
  )
}

export function hasProjectGroupForRepoExecutionHost(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  groupId: string,
  groups: readonly ProjectGroup[]
): boolean {
  const candidates = groups.filter((group) => group.id === groupId)
  const repoHostId = getRepoExecutionHostId(repo)
  if (
    candidates.length === 1 &&
    resolveDeclaredFolderScopeOwner(candidates[0]!).status === 'unknown'
  ) {
    return true
  }
  const owners = candidates.map(resolveProjectGroupOwner)
  return (
    !owners.some((owner) => owner.status === 'invalid') &&
    owners.some((owner) => owner.status === 'owned' && owner.executionHostId === repoHostId)
  )
}

export function findProjectGroupForConnection(
  groups: readonly ProjectGroup[],
  groupId: string,
  connectionId?: string | null
): ProjectGroup | undefined {
  const candidates = groups.filter((group) => group.id === groupId)
  if (candidates.some((group) => resolveDeclaredFolderScopeOwner(group).status === 'invalid')) {
    return undefined
  }
  if (connectionId === undefined) {
    return candidates.length === 1 ? candidates[0] : undefined
  }
  const executionHostId = connectionId
    ? toSshExecutionHostId(connectionId)
    : LOCAL_EXECUTION_HOST_ID
  const owners = candidates.map(resolveProjectGroupOwner)
  const matches = candidates.filter(
    (_, index) =>
      owners[index]?.status === 'owned' && owners[index].executionHostId === executionHostId
  )
  if (matches.length === 1) {
    return matches[0]
  }
  const soleGroup = candidates.length === 1 ? candidates[0] : undefined
  return soleGroup &&
    normalizeExecutionHostId(soleGroup.executionHostId) === null &&
    soleGroup.connectionId === undefined
    ? soleGroup
    : undefined
}

export function getProjectGroupSubtreeIds(
  groups: readonly Pick<ProjectGroup, 'id' | 'parentGroupId'>[],
  rootGroupId: string
): Set<string> {
  const childGroupsByParentId = new Map<string, string[]>()
  for (const group of groups) {
    if (!group.parentGroupId) {
      continue
    }
    const children = childGroupsByParentId.get(group.parentGroupId) ?? []
    children.push(group.id)
    childGroupsByParentId.set(group.parentGroupId, children)
  }

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
