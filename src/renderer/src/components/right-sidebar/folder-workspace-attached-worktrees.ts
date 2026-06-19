import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type {
  FolderWorkspace,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage
} from '../../../../shared/types'

export type AttachedWorktreeResolution = {
  folderWorkspace: FolderWorkspace | null
  childWorktrees: Worktree[]
  lineageChildrenByParentId: Map<string, Worktree[]>
  rootChildWorktrees: Worktree[]
}

type AttachedWorktreeResolverArgs = {
  activeWorkspaceKey: string | null
  activeWorktreeId: string | null
  folderWorkspaces: readonly FolderWorkspace[]
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
  worktreeLineageById: Record<string, WorktreeLineage>
  worktreesByRepo: Record<string, readonly Worktree[]>
}

export function getWorktreeActivityTime(worktree: Worktree): number {
  return Math.max(worktree.lastActivityAt ?? 0, worktree.createdAt ?? 0, worktree.sortOrder ?? 0)
}

export function getAttachedWorktreesForFolderWorkspace({
  activeWorkspaceKey,
  activeWorktreeId,
  folderWorkspaces,
  workspaceLineageByChildKey,
  worktreeLineageById,
  worktreesByRepo
}: AttachedWorktreeResolverArgs): AttachedWorktreeResolution {
  const activeScope = parseWorkspaceKey(activeWorkspaceKey ?? activeWorktreeId ?? '')
  const folderWorkspace =
    activeScope?.type === 'folder'
      ? (folderWorkspaces.find((workspace) => workspace.id === activeScope.folderWorkspaceId) ??
        null)
      : null

  if (!folderWorkspace) {
    return {
      folderWorkspace: null,
      childWorktrees: [],
      lineageChildrenByParentId: new Map(),
      rootChildWorktrees: []
    }
  }

  const folderKey = folderWorkspaceKey(folderWorkspace.id)
  const worktreeById = getWorktreeById(worktreesByRepo)
  const childWorktrees = Object.values(workspaceLineageByChildKey)
    .filter((lineage) => lineage.parentWorkspaceKey === folderKey)
    .map((lineage) => getLineageChildWorktree(lineage, worktreeById))
    .filter((worktree): worktree is Worktree => worktree !== null)
    .sort(sortWorktreesByRecentActivity)

  const childWorktreeIds = new Set(childWorktrees.map((worktree) => worktree.id))
  const lineageChildrenByParentId = getLineageChildrenByParentId(
    worktreeLineageById,
    worktreeById,
    childWorktreeIds
  )
  const nestedChildIds = new Set<string>()
  for (const children of lineageChildrenByParentId.values()) {
    for (const child of children) {
      nestedChildIds.add(child.id)
    }
  }
  const topLevelChildWorktrees = childWorktrees.filter(
    (worktree) => !nestedChildIds.has(worktree.id)
  )
  const rootChildWorktrees =
    topLevelChildWorktrees.length > 0 ? topLevelChildWorktrees : childWorktrees

  return {
    folderWorkspace,
    childWorktrees,
    lineageChildrenByParentId,
    rootChildWorktrees
  }
}

export function getLineageChildrenByParentId(
  lineageById: Record<string, WorktreeLineage>,
  worktreeById: Map<string, Worktree>,
  rootWorktreeIds: ReadonlySet<string>
): Map<string, Worktree[]> {
  const descendantsByParentId = new Map<string, Worktree[]>()
  const includedIds = new Set(rootWorktreeIds)
  let added = true

  while (added) {
    added = false
    for (const lineage of Object.values(lineageById)) {
      const parent = worktreeById.get(lineage.parentWorktreeId)
      const child = worktreeById.get(lineage.worktreeId)
      if (!isValidLineageChild(parent, child, lineage, includedIds)) {
        continue
      }
      includedIds.add(child.id)
      added = true
    }
  }

  for (const worktreeId of includedIds) {
    const child = worktreeById.get(worktreeId)
    if (!child) {
      continue
    }
    const lineage = lineageById[child.id]
    if (!lineage || !includedIds.has(lineage.parentWorktreeId)) {
      continue
    }
    const parent = worktreeById.get(lineage.parentWorktreeId)
    if (!isCurrentLineagePair(parent, child, lineage)) {
      continue
    }
    const children = descendantsByParentId.get(parent.id) ?? []
    children.push(child)
    descendantsByParentId.set(parent.id, children)
  }

  for (const children of descendantsByParentId.values()) {
    children.sort(sortWorktreesByRecentActivity)
  }

  return descendantsByParentId
}

function getWorktreeById(
  worktreesByRepo: Record<string, readonly Worktree[]>
): Map<string, Worktree> {
  return new Map(
    Object.values(worktreesByRepo)
      .flat()
      .map((worktree) => [worktree.id, worktree])
  )
}

function getLineageChildWorktree(
  lineage: WorkspaceLineage,
  worktreeById: Map<string, Worktree>
): Worktree | null {
  const childScope = parseWorkspaceKey(lineage.childWorkspaceKey)
  if (childScope?.type !== 'worktree') {
    return null
  }
  const worktree = worktreeById.get(childScope.worktreeId)
  if (!worktree || worktree.isArchived) {
    return null
  }
  if (lineage.childInstanceId && lineage.childInstanceId !== worktree.instanceId) {
    return null
  }
  return worktree
}

function isValidLineageChild(
  parent: Worktree | undefined,
  child: Worktree | undefined,
  lineage: WorktreeLineage,
  includedIds: ReadonlySet<string>
): child is Worktree {
  if (
    !parent ||
    !child ||
    parent.isArchived ||
    child.isArchived ||
    !includedIds.has(parent.id) ||
    includedIds.has(child.id)
  ) {
    return false
  }
  return isCurrentLineagePair(parent, child, lineage)
}

function isCurrentLineagePair(
  parent: Worktree | undefined,
  child: Worktree,
  lineage: WorktreeLineage
): parent is Worktree {
  return Boolean(
    parent &&
    !parent.isArchived &&
    !child.isArchived &&
    child.instanceId === lineage.worktreeInstanceId &&
    parent.instanceId === lineage.parentWorktreeInstanceId
  )
}

function sortWorktreesByRecentActivity(left: Worktree, right: Worktree): number {
  return (
    getWorktreeActivityTime(right) - getWorktreeActivityTime(left) ||
    left.displayName.localeCompare(right.displayName)
  )
}
