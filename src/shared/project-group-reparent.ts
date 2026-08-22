import type { ProjectGroup } from './project-group-types'

/** Deepest header depth the sidebar indents distinctly; root groups sit at depth 0. */
export const MAX_PROJECT_GROUP_DEPTH = 6

export type ProjectGroupReparentRejection =
  | 'group-not-found'
  | 'parent-not-found'
  | 'self'
  | 'descendant'
  | 'too-deep'

type ProjectGroupNode = Pick<ProjectGroup, 'id' | 'parentGroupId'>

function indexById(groups: readonly ProjectGroupNode[]): Map<string, ProjectGroupNode> {
  return new Map(groups.map((group) => [group.id, group]))
}

/** Depth of a group counting from its root ancestor (root = 0). Dangling parents count as roots. */
export function getProjectGroupDepth(groups: readonly ProjectGroupNode[], groupId: string): number {
  const byId = indexById(groups)
  const visited = new Set<string>()
  let depth = 0
  let current = byId.get(groupId)
  while (current?.parentGroupId && byId.has(current.parentGroupId)) {
    // Why: persisted cycles would otherwise loop forever; stop at the first repeat.
    if (visited.has(current.id)) {
      break
    }
    visited.add(current.id)
    depth += 1
    current = byId.get(current.parentGroupId)
  }
  return depth
}

/** Levels below a group: 0 when it has no child groups. */
export function getProjectGroupSubtreeHeight(
  groups: readonly ProjectGroupNode[],
  groupId: string
): number {
  const childIdsByParentId = new Map<string, string[]>()
  for (const group of groups) {
    if (!group.parentGroupId) {
      continue
    }
    const children = childIdsByParentId.get(group.parentGroupId) ?? []
    children.push(group.id)
    childIdsByParentId.set(group.parentGroupId, children)
  }
  let height = 0
  const visited = new Set<string>([groupId])
  let frontier = [groupId]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const id of frontier) {
      for (const childId of childIdsByParentId.get(id) ?? []) {
        if (!visited.has(childId)) {
          visited.add(childId)
          next.push(childId)
        }
      }
    }
    if (next.length === 0) {
      break
    }
    height += 1
    frontier = next
  }
  return height
}

export function isProjectGroupDescendantOf(
  groups: readonly ProjectGroupNode[],
  groupId: string,
  ancestorId: string
): boolean {
  const byId = indexById(groups)
  const visited = new Set<string>()
  let current = byId.get(groupId)
  while (current?.parentGroupId) {
    if (current.parentGroupId === ancestorId) {
      return true
    }
    if (visited.has(current.id)) {
      return false
    }
    visited.add(current.id)
    current = byId.get(current.parentGroupId)
  }
  return false
}

/** Why a group cannot be re-parented under `parentGroupId`, or null when the move is valid. */
export function getProjectGroupReparentRejection(
  groups: readonly ProjectGroupNode[],
  groupId: string,
  parentGroupId: string | null,
  maxDepth = MAX_PROJECT_GROUP_DEPTH
): ProjectGroupReparentRejection | null {
  const byId = indexById(groups)
  if (!byId.has(groupId)) {
    return 'group-not-found'
  }
  if (parentGroupId === null) {
    return null
  }
  if (parentGroupId === groupId) {
    return 'self'
  }
  if (!byId.has(parentGroupId)) {
    return 'parent-not-found'
  }
  if (isProjectGroupDescendantOf(groups, parentGroupId, groupId)) {
    return 'descendant'
  }
  const deepestAfterMove =
    getProjectGroupDepth(groups, parentGroupId) + 1 + getProjectGroupSubtreeHeight(groups, groupId)
  return deepestAfterMove > maxDepth ? 'too-deep' : null
}

/** Why a new child cannot be created under `parentGroupId`, or null when allowed. */
export function getProjectGroupCreateChildRejection(
  groups: readonly ProjectGroupNode[],
  parentGroupId: string,
  maxDepth = MAX_PROJECT_GROUP_DEPTH
): Extract<ProjectGroupReparentRejection, 'parent-not-found' | 'too-deep'> | null {
  if (!groups.some((group) => group.id === parentGroupId)) {
    return 'parent-not-found'
  }
  return getProjectGroupDepth(groups, parentGroupId) + 1 > maxDepth ? 'too-deep' : null
}

export function describeProjectGroupReparentRejection(
  rejection: ProjectGroupReparentRejection,
  maxDepth = MAX_PROJECT_GROUP_DEPTH
): string {
  switch (rejection) {
    case 'group-not-found':
      return 'Project group not found'
    case 'parent-not-found':
      return 'Parent project group not found'
    case 'self':
      return 'A project group cannot be moved into itself'
    case 'descendant':
      return 'A project group cannot be moved into one of its own subgroups'
    case 'too-deep':
      return `Project groups can be nested at most ${maxDepth} levels deep`
  }
}
