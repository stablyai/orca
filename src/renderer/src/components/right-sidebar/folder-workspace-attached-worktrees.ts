import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type {
  FolderWorkspace,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage
} from '../../../../shared/types'
import { compareWorktreeDisplayName } from '@/lib/worktree-display-name-order'
import { getProjectedWorktreeLineageChildrenByParentId } from '../sidebar/worktree-lineage-projection'

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
  const projectedChildrenByParentId = getProjectedWorktreeLineageChildrenByParentId(
    lineageById,
    worktreeById
  )
  const includedIds = new Set(rootWorktreeIds)
  const queue = [...rootWorktreeIds]
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of projectedChildrenByParentId.get(queue[index]) ?? []) {
      if (child.isArchived || includedIds.has(child.id)) {
        continue
      }
      includedIds.add(child.id)
      queue.push(child.id)
    }
  }

  const descendantsByParentId = new Map<string, Worktree[]>()
  for (const parentId of includedIds) {
    const children = (projectedChildrenByParentId.get(parentId) ?? []).filter(
      (child) => includedIds.has(child.id) && !child.isArchived
    )
    if (children.length > 0) {
      descendantsByParentId.set(parentId, children)
    }
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

function sortWorktreesByRecentActivity(left: Worktree, right: Worktree): number {
  return (
    getWorktreeActivityTime(right) - getWorktreeActivityTime(left) ||
    compareWorktreeDisplayName(left, right)
  )
}
