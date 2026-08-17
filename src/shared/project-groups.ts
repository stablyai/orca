import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup, ProjectGroupCreatedFrom } from './project-group-types'
import type { Repo } from './repo-types'

export const UNGROUPED_PROJECT_GROUP_KEY = 'project-group:ungrouped'

export type ProjectGroupOwnerIndex = {
  byIdentity: ReadonlyMap<string, ProjectGroup>
  byId: ReadonlyMap<string, readonly ProjectGroup[]>
}

export function getProjectGroupOwnerHostId(
  group: Pick<ProjectGroup, 'connectionId' | 'executionHostId'>
): ExecutionHostId {
  return (
    normalizeExecutionHostId(group.executionHostId) ??
    (group.connectionId ? toSshExecutionHostId(group.connectionId) : LOCAL_EXECUTION_HOST_ID)
  )
}

export function getProjectGroupOwnerIdentity(
  group: Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>
): string {
  return getProjectGroupIdentity(group.id, getProjectGroupOwnerHostId(group))
}

export function getProjectGroupIdentity(groupId: string, ownerHostId: ExecutionHostId): string {
  return JSON.stringify([ownerHostId, groupId])
}

export function buildProjectGroupOwnerIndex(
  projectGroups: readonly ProjectGroup[]
): ProjectGroupOwnerIndex {
  const byIdentity = new Map<string, ProjectGroup>()
  const byId = new Map<string, ProjectGroup[]>()
  for (const group of projectGroups) {
    byIdentity.set(getProjectGroupOwnerIdentity(group), group)
    const matches = byId.get(group.id) ?? []
    matches.push(group)
    byId.set(group.id, matches)
  }
  return { byIdentity, byId }
}

export function resolveProjectGroupOwner(
  index: ProjectGroupOwnerIndex,
  groupId: string,
  ownerHostId?: ExecutionHostId
): ProjectGroup | null {
  if (ownerHostId) {
    return index.byIdentity.get(getProjectGroupIdentity(groupId, ownerHostId)) ?? null
  }
  const matches = index.byId.get(groupId) ?? []
  return matches.length === 1 ? (matches[0] ?? null) : null
}

export function resolveProjectGroupMembership(
  index: ProjectGroupOwnerIndex,
  groupId: string,
  ownerHostId: ExecutionHostId
): ProjectGroup | null {
  return index.byIdentity.get(getProjectGroupIdentity(groupId, ownerHostId)) ?? null
}

export function getFolderWorkspaceProjectGroupOwnerHostId(
  workspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId' | 'projectGroupId'>,
  index: ProjectGroupOwnerIndex
): ExecutionHostId {
  const executionHostId = normalizeExecutionHostId(workspace.executionHostId)
  if (executionHostId) {
    return executionHostId
  }
  if (workspace.connectionId) {
    return toSshExecutionHostId(workspace.connectionId)
  }
  const group = resolveFolderWorkspaceProjectGroup(index, workspace)
  if (group) {
    return getProjectGroupOwnerHostId(group)
  }
  return LOCAL_EXECUTION_HOST_ID
}

export function resolveFolderWorkspaceProjectGroup(
  index: ProjectGroupOwnerIndex,
  workspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId' | 'projectGroupId'>
): ProjectGroup | null {
  const executionHostId = normalizeExecutionHostId(workspace.executionHostId)
  if (executionHostId) {
    return resolveProjectGroupMembership(index, workspace.projectGroupId, executionHostId)
  }
  if (workspace.connectionId !== undefined) {
    const ownerHostId = workspace.connectionId
      ? toSshExecutionHostId(workspace.connectionId)
      : LOCAL_EXECUTION_HOST_ID
    return resolveProjectGroupMembership(index, workspace.projectGroupId, ownerHostId)
  }
  return resolveProjectGroupOwner(index, workspace.projectGroupId)
}

export function getProjectGroupOwnerSubtreeIdentities(
  projectGroups: readonly ProjectGroup[],
  rootGroup: ProjectGroup
): Set<string> {
  const childrenByParentIdentity = new Map<string, ProjectGroup[]>()
  for (const group of projectGroups) {
    if (!group.parentGroupId) {
      continue
    }
    const parentIdentity = getProjectGroupIdentity(
      group.parentGroupId,
      getProjectGroupOwnerHostId(group)
    )
    const children = childrenByParentIdentity.get(parentIdentity) ?? []
    children.push(group)
    childrenByParentIdentity.set(parentIdentity, children)
  }

  const subtreeIdentities = new Set<string>()
  const pending = [rootGroup]
  while (pending.length > 0) {
    const group = pending.pop()!
    const identity = getProjectGroupOwnerIdentity(group)
    if (subtreeIdentities.has(identity)) {
      continue
    }
    subtreeIdentities.add(identity)
    for (const child of childrenByParentIdentity.get(identity) ?? []) {
      pending.push(child)
    }
  }
  return subtreeIdentities
}

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
    const now = Date.now()
    const executionHostId = normalizeExecutionHostId(raw.executionHostId)
    const group: ProjectGroup = {
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
      ...(executionHostId ? { executionHostId } : {})
    }
    const identity = getProjectGroupOwnerIdentity(group)
    if (seen.has(identity)) {
      continue
    }
    seen.add(identity)
    groups.push(group)
  }
  groups.sort(
    (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
  )
  const groupIdentities = new Set(groups.map(getProjectGroupOwnerIdentity))
  for (const group of groups) {
    const parentIdentity = group.parentGroupId
      ? getProjectGroupIdentity(group.parentGroupId, getProjectGroupOwnerHostId(group))
      : null
    if (
      group.parentGroupId === group.id ||
      (parentIdentity !== null && !groupIdentities.has(parentIdentity))
    ) {
      group.parentGroupId = null
    }
  }
  return groups
}

export function clearMissingProjectGroupMemberships(repos: Repo[], groups: ProjectGroup[]): Repo[] {
  const index = buildProjectGroupOwnerIndex(groups)
  return repos.map((repo) =>
    repo.projectGroupId &&
    !resolveProjectGroupMembership(index, repo.projectGroupId, getRepoExecutionHostId(repo))
      ? { ...repo, projectGroupId: null }
      : repo
  )
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
    // Why: avoid V8 argument limits in wide imported project-group trees.
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
