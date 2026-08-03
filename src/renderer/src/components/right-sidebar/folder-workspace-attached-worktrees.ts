import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type {
  FolderWorkspace,
  Repo,
  Worktree,
  WorktreeLineage,
  WorkspaceLineage
} from '../../../../shared/types'
import { compareWorktreeDisplayName } from '@/lib/worktree-display-name-order'
import { getProjectedWorktreeLineageChildrenByParentId } from '../sidebar/worktree-lineage-projection'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'

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
  repos: readonly Repo[]
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
  repos,
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
  const lineageChildWorktrees = Object.values(workspaceLineageByChildKey)
    .filter((lineage) => lineage.parentWorkspaceKey === folderKey)
    .map((lineage) => getLineageChildWorktree(lineage, worktreeById))
    .filter((worktree): worktree is Worktree => worktree !== null)

  const childWorktrees = mergeUniqueWorktrees([
    ...lineageChildWorktrees,
    ...getNestedRegisteredRepoWorktrees(folderWorkspace, repos, worktreesByRepo)
  ]).sort(sortWorktreesByRecentActivity)

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

function getNestedRegisteredRepoWorktrees(
  folderWorkspace: FolderWorkspace,
  repos: readonly Repo[],
  worktreesByRepo: Record<string, readonly Worktree[]>
): Worktree[] {
  return repos
    .filter((repo) => repo.kind !== 'folder')
    .filter((repo) => sameConnection(repo.connectionId, folderWorkspace.connectionId))
    .filter((repo) => isNestedPath(folderWorkspace.folderPath, repo.path))
    .flatMap((repo) =>
      (worktreesByRepo[repo.id] ?? []).filter(
        (worktree) =>
          !worktree.isArchived && isNestedPath(folderWorkspace.folderPath, worktree.path)
      )
    )
}

function mergeUniqueWorktrees(worktrees: readonly Worktree[]): Worktree[] {
  return [...new Map(worktrees.map((worktree) => [worktree.id, worktree])).values()]
}

function sameConnection(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  return (left ?? null) === (right ?? null)
}

function isNestedPath(rootPath: string, candidatePath: string): boolean {
  return (
    normalizeRuntimePathForComparison(rootPath) !==
      normalizeRuntimePathForComparison(candidatePath) &&
    isPathInsideOrEqual(rootPath, candidatePath)
  )
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
