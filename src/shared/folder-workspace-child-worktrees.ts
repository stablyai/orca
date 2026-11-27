// The worktrees a folder workspace lists under it, as the sidebar nests them; shared by the desktop and the phone page.
import { parseWorkspaceKey } from './workspace/identity/workspace-scope'
import type { WorkspaceLineage, WorktreeLineage } from './worktree/lineage-types'
import type { Worktree } from './worktree/types'
import { compareWorktreeDisplayName } from './worktree/display-name-order'
import { getProjectedWorktreeLineageChildrenByParentId } from './sidebar-list/lineage/worktree-lineage-projection'
import { getWorktreeHostIdentity } from './worktree/host-qualified-identity'
import { isWorktreeRetiredByRemoval } from './worktree/removal/removal-visibility'

export type FolderWorkspaceChildWorktrees = {
  /** The folder's own children, most recent first. */
  childWorktrees: Worktree[]
  /** Each listed workspace's children, by parent host identity. */
  lineageChildrenByParentIdentity: Map<string, Worktree[]>
}

export function getWorktreeActivityTime(worktree: Worktree): number {
  return Math.max(worktree.lastActivityAt ?? 0, worktree.createdAt ?? 0, worktree.sortOrder ?? 0)
}

/** The workspaces the sidebar nests under one folder workspace, with their own children, from the
 * sidebar's children by parent host identity (selectSidebarChildrenByParentIdentity). */
export function getFolderWorkspaceChildWorktrees(
  folderIdentity: string,
  childrenByParentIdentity: ReadonlyMap<string, readonly Worktree[]>
): FolderWorkspaceChildWorktrees {
  const childrenOf = (parent: Pick<Worktree, 'id' | 'hostId'>) =>
    childrenByParentIdentity.get(getWorktreeHostIdentity(parent)) ?? []
  const roots = (childrenByParentIdentity.get(folderIdentity) ?? []).filter(
    (child) => !child.isArchived
  )
  const { listedChildrenOf, descendantsByParentIdentity } = walkDescendants(roots, childrenOf)
  return {
    childWorktrees: listedChildrenOf(roots),
    lineageChildrenByParentIdentity: descendantsByParentIdentity
  }
}

export function getLineageChildrenByParentIdentity(
  lineageById: Record<string, WorktreeLineage>,
  worktreeById: Map<string, Worktree>,
  rootWorktreeIds: ReadonlySet<string>
): Map<string, Worktree[]> {
  const projectedChildrenByParentId = getProjectedWorktreeLineageChildrenByParentId(
    lineageById,
    worktreeById
  )
  const roots = [...rootWorktreeIds].flatMap((id) => worktreeById.get(id) ?? [])
  const childrenOf = (parent: Worktree) => projectedChildrenByParentId.get(parent.id) ?? []
  const { listedChildrenOf, descendantsByParentIdentity } = walkDescendants(roots, childrenOf)
  // The caller picked these roots, so a retired root still keys its lifted children.
  for (const root of roots.filter(isWorktreeRetiredByRemoval)) {
    const children = listedChildrenOf(childrenOf(root))
    if (children.length > 0) {
      descendantsByParentIdentity.set(getWorktreeHostIdentity(root), children)
    }
  }
  return descendantsByParentIdentity
}

/** Each listed parent's unarchived children by host identity, most recent first, over every
 * descendant of `roots`; a bare id would merge same-path workspaces on different machines.
 * A row retired by removal is hidden, and its live children list under its nearest listed ancestor. */
function walkDescendants(
  roots: readonly Worktree[],
  childrenOf: (parent: Worktree) => readonly Worktree[]
): {
  listedChildrenOf: (children: readonly Worktree[]) => Worktree[]
  descendantsByParentIdentity: Map<string, Worktree[]>
} {
  const included = new Map(roots.map((root) => [getWorktreeHostIdentity(root), root]))
  const queue = [...roots]
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of childrenOf(queue[index])) {
      const identity = getWorktreeHostIdentity(child)
      if (child.isArchived || included.has(identity)) {
        continue
      }
      included.set(identity, child)
      queue.push(child)
    }
  }

  const listedChildrenOf = (children: readonly Worktree[]): Worktree[] => {
    const listed: Worktree[] = []
    const seen = new Set<string>()
    const visit = (child: Worktree): void => {
      const identity = getWorktreeHostIdentity(child)
      if (child.isArchived || !included.has(identity) || seen.has(identity)) {
        return
      }
      seen.add(identity)
      if (isWorktreeRetiredByRemoval(child)) {
        childrenOf(child).forEach(visit)
      } else {
        listed.push(child)
      }
    }
    children.forEach(visit)
    return listed.sort(sortWorktreesByRecentActivity)
  }

  const descendantsByParentIdentity = new Map<string, Worktree[]>()
  for (const parent of included.values()) {
    if (isWorktreeRetiredByRemoval(parent)) {
      continue
    }
    const children = listedChildrenOf(childrenOf(parent))
    if (children.length > 0) {
      descendantsByParentIdentity.set(getWorktreeHostIdentity(parent), children)
    }
  }
  return { listedChildrenOf, descendantsByParentIdentity }
}

/** Exported so the composer's parent picker offers exactly the roots this view attaches. */
export function getLineageChildWorktree(
  lineage: WorkspaceLineage,
  worktreeById: Map<string, Worktree>
): Worktree | null {
  const childScope = parseWorkspaceKey(lineage.childWorkspaceKey)
  if (childScope?.type !== 'worktree') {
    return null
  }
  const worktree = worktreeById.get(childScope.worktreeId)
  return worktree && !worktree.isArchived && lineageNamesWorktreeInstance(lineage, worktree)
    ? worktree
    : null
}

/** A link recorded for an earlier worktree at the same path names a different workspace. */
export function lineageNamesWorktreeInstance(
  lineage: Pick<WorkspaceLineage, 'childInstanceId'>,
  worktree: Pick<Worktree, 'instanceId'>
): boolean {
  return !lineage.childInstanceId || lineage.childInstanceId === worktree.instanceId
}

function sortWorktreesByRecentActivity(left: Worktree, right: Worktree): number {
  return (
    getWorktreeActivityTime(right) - getWorktreeActivityTime(left) ||
    compareWorktreeDisplayName(left, right)
  )
}
