import { normalizeExecutionHostId } from './execution-host'
import type { Repo, ProjectGroup, ProjectGroupCreatedFrom } from './types'

export const UNGROUPED_PROJECT_GROUP_KEY = 'project-group:ungrouped'

/** Levels counted from 1 at root. Caps manual nesting (drag, "New subgroup");
 *  folder-scan imports are exempt so deep scanned trees keep their shape. */
export const MAX_MANUAL_PROJECT_GROUP_DEPTH = 3

// Why: corruption guard only — must stay above the folder-scan depth limit
// (scan maxDepth <= 8 plus the import root) so normalize never restructures
// legitimately imported trees.
export const MAX_PERSISTED_PROJECT_GROUP_DEPTH = 10

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
  groups.sort(
    (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
  )
  const groupIds = new Set(groups.map((group) => group.id))
  for (const group of groups) {
    if (group.parentGroupId === group.id || !groupIds.has(group.parentGroupId ?? '')) {
      group.parentGroupId = null
    }
  }
  breakProjectGroupParentCycles(groups)
  // Why: clamp from pre-clamp depths so one corrupt over-deep chain collapses
  // predictably instead of cascading as earlier clamps shorten the chain.
  // Depths are memoized across groups; per-group chain walks are quadratic on
  // the huge imported catalogs this loader must handle.
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const depthById = new Map<string, number>()
  for (const group of groups) {
    const path: ProjectGroup[] = []
    let current: ProjectGroup | undefined = group
    while (current && !depthById.has(current.id)) {
      path.push(current)
      current = current.parentGroupId ? groupById.get(current.parentGroupId) : undefined
    }
    let depth = current ? depthById.get(current.id)! : 0
    for (let index = path.length - 1; index >= 0; index -= 1) {
      depth += 1
      depthById.set(path[index]!.id, depth)
    }
  }
  for (const group of groups) {
    if ((depthById.get(group.id) ?? 1) > MAX_PERSISTED_PROJECT_GROUP_DEPTH) {
      group.parentGroupId = null
    }
  }
  return groups
}

// Why: persisted data may contain parent cycles (hand-edited state, sync
// races); rendering walks parent chains, so cycles must clamp to root here.
function breakProjectGroupParentCycles(groups: ProjectGroup[]): void {
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const resolvesToRoot = new Set<string>()
  for (const group of groups) {
    const path: ProjectGroup[] = []
    const pathIds = new Set<string>()
    let current: ProjectGroup | undefined = group
    while (current && !resolvesToRoot.has(current.id)) {
      if (pathIds.has(current.id)) {
        for (const member of path.slice(path.indexOf(current))) {
          member.parentGroupId = null
        }
        break
      }
      path.push(current)
      pathIds.add(current.id)
      current = current.parentGroupId ? groupById.get(current.parentGroupId) : undefined
    }
    for (const member of path) {
      resolvesToRoot.add(member.id)
    }
  }
}

/** 1-based depth of a group counting resolvable ancestors; cycle-safe. */
export function getProjectGroupDepth(
  groups: readonly Pick<ProjectGroup, 'id' | 'parentGroupId'>[],
  groupId: string
): number {
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const visited = new Set<string>()
  let depth = 0
  let current = groupById.get(groupId)
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    depth += 1
    current = current.parentGroupId ? groupById.get(current.parentGroupId) : undefined
  }
  return depth
}

/** Levels below the group inside its own subtree (0 for a leaf). */
export function getProjectGroupSubtreeHeight(
  groups: readonly Pick<ProjectGroup, 'id' | 'parentGroupId'>[],
  groupId: string
): number {
  const childGroupsByParentId = new Map<string, string[]>()
  for (const group of groups) {
    if (!group.parentGroupId) {
      continue
    }
    const children = childGroupsByParentId.get(group.parentGroupId) ?? []
    children.push(group.id)
    childGroupsByParentId.set(group.parentGroupId, children)
  }
  let height = 0
  const seen = new Set<string>([groupId])
  let frontier = [groupId]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      for (const childId of childGroupsByParentId.get(id) ?? []) {
        if (!seen.has(childId)) {
          seen.add(childId)
          next.push(childId)
        }
      }
    }
    if (next.length > 0) {
      height += 1
    }
    frontier = next
  }
  return height
}

export type ProjectGroupReparentViolation =
  | 'missing-group'
  | 'missing-parent'
  | 'self'
  | 'cycle'
  | 'depth'

/** Preflight/authoritative check shared by renderer drop targeting and the
 *  main-process update path. `null` parent (move to root) is always valid. */
export function getProjectGroupReparentViolation(
  groups: readonly Pick<ProjectGroup, 'id' | 'parentGroupId'>[],
  groupId: string,
  parentGroupId: string | null
): ProjectGroupReparentViolation | null {
  const groupIds = new Set(groups.map((group) => group.id))
  if (!groupIds.has(groupId)) {
    return 'missing-group'
  }
  if (parentGroupId === null) {
    return null
  }
  if (parentGroupId === groupId) {
    return 'self'
  }
  if (!groupIds.has(parentGroupId)) {
    return 'missing-parent'
  }
  if (getProjectGroupSubtreeIds(groups, groupId).has(parentGroupId)) {
    return 'cycle'
  }
  const resultingDepth =
    getProjectGroupDepth(groups, parentGroupId) + 1 + getProjectGroupSubtreeHeight(groups, groupId)
  if (resultingDepth > MAX_MANUAL_PROJECT_GROUP_DEPTH) {
    return 'depth'
  }
  return null
}

export function clearMissingProjectGroupMemberships(repos: Repo[], groups: ProjectGroup[]): Repo[] {
  const groupIds = new Set(groups.map((group) => group.id))
  return repos.map((repo) =>
    repo.projectGroupId && !groupIds.has(repo.projectGroupId)
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
