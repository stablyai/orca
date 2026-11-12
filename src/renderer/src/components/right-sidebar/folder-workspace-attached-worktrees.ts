import { isWorktreeRetiredByRemoval } from '../../../../shared/worktree/removal-visibility'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceHostIdentity } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { compareWorktreeDisplayName } from '@/lib/workspace/display/worktree-display-name-order'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { getProjectedWorktreeLineage } from '../../../../shared/worktree/workspace-lineage-graph'
import {
  getSidebarLineageParentsByIdentity,
  type SidebarLineageParentIdentities,
  getProjectedWorktreeLineageChildrenByParentId
} from '../../../../shared/sidebar-list/worktree-lineage-projection'

export type AttachedWorktreeResolution = {
  folderWorkspace: FolderWorkspace | null
  childWorktrees: Worktree[]
  owners: AttachedWorktreeOwner[]
  lineageChildrenByParentId: Map<string, Worktree[]>
  rootChildWorktrees: Worktree[]
}

export type AttachedWorktreeOwner = {
  worktreeId: string
  repoId: string
  executionHostId: ExecutionHostId
  worktree: Worktree
  attachedAt: number
}

export function attachedWorktreeOwnerKey(owner: AttachedWorktreeOwner): string {
  return `${owner.executionHostId}::${owner.worktreeId}::${owner.worktree.instanceId ?? ''}`
}

type AttachedWorktreeResolverArgs = {
  executionHostId?: ExecutionHostId | null
  lineageParentIdentities?: SidebarLineageParentIdentities
  activeWorkspaceKey: string | null
  activeWorktreeId: string | null
  folderWorkspaces: readonly FolderWorkspace[]
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
  worktreeLineageById: Record<string, WorktreeLineage>
  worktreesByRepo: Record<string, readonly Worktree[]>
  /** Children on other machines (selectCrossStoreFolderChildrenById). */
  crossStoreChildrenByFolderId: ReadonlyMap<string, readonly Worktree[]>
}

export function getWorktreeActivityTime(worktree: Worktree): number {
  return Math.max(worktree.lastActivityAt ?? 0, worktree.createdAt ?? 0, worktree.sortOrder ?? 0)
}

export function getAttachedWorktreesForFolderWorkspace({
  executionHostId,
  lineageParentIdentities,
  activeWorkspaceKey,
  activeWorktreeId,
  folderWorkspaces,
  workspaceLineageByChildKey,
  worktreeLineageById,
  worktreesByRepo,
  crossStoreChildrenByFolderId
}: AttachedWorktreeResolverArgs): AttachedWorktreeResolution {
  const activeScope = parseWorkspaceKey(activeWorkspaceKey ?? activeWorktreeId ?? '')
  const folderWorkspace =
    activeScope?.type === 'folder'
      ? (folderWorkspaces.find(
          (workspace) =>
            workspace.id === activeScope.folderWorkspaceId &&
            (!executionHostId || getRepoExecutionHostId(workspace) === executionHostId)
        ) ?? null)
      : null

  if (!folderWorkspace) {
    return {
      folderWorkspace: null,
      childWorktrees: [],
      owners: [],
      lineageChildrenByParentId: new Map(),
      rootChildWorktrees: []
    }
  }

  const folderKey = folderWorkspaceKey(folderWorkspace.id)
  const folderHost = getRepoExecutionHostId(folderWorkspace)
  const rows = new Map<string, Worktree>(
    Object.values(worktreesByRepo).flatMap((copies) =>
      copies.map((row) => [getWorktreeHostIdentity(row), row] as const)
    )
  )
  // Status stores are keyed by worktree ID; prefer the folder host, then the legacy selector's first copy.
  const selectedById = new Map<string, Worktree>()
  for (const row of rows.values()) {
    const selected = selectedById.get(row.id)
    if (
      !selected ||
      ((selected.hostId ?? 'local') !== folderHost && (row.hostId ?? 'local') === folderHost)
    ) {
      selectedById.set(row.id, row)
    }
  }
  const parentByIdentity = getSidebarLineageParentsByIdentity(
    worktreeLineageById,
    rows,
    lineageParentIdentities
  )
  const childrenByParent = new Map<string, Worktree[]>()
  for (const [identity, parent] of parentByIdentity) {
    const child = rows.get(identity)!
    if (child.isArchived || isWorktreeRetiredByRemoval(child)) {
      continue
    }
    const parentIdentity = getWorktreeHostIdentity(parent)
    const children = childrenByParent.get(parentIdentity) ?? []
    children.push(child)
    childrenByParent.set(parentIdentity, children)
  }
  const rootLineageByChildId = new Map<string, WorkspaceLineage[]>()
  for (const lineage of Object.values(workspaceLineageByChildKey)) {
    const child = parseWorkspaceKey(lineage.childWorkspaceKey)
    if (lineage.parentWorkspaceKey !== folderKey || child?.type !== 'worktree') {
      continue
    }
    const entries = rootLineageByChildId.get(child.worktreeId) ?? []
    entries.push(lineage)
    rootLineageByChildId.set(child.worktreeId, entries)
  }
  const members = new Map<string, AttachedWorktreeOwner>()
  const queue: Worktree[] = []
  const add = (worktree: Worktree, attachedAt: number) => {
    const identity = getWorktreeHostIdentity(worktree)
    if (
      worktree.isArchived ||
      isWorktreeRetiredByRemoval(worktree) ||
      members.has(identity) ||
      selectedById.get(worktree.id) !== worktree
    ) {
      return
    }
    members.set(identity, {
      worktreeId: worktree.id,
      repoId: worktree.repoId,
      executionHostId: worktree.hostId ?? folderHost,
      worktree,
      attachedAt
    })
    queue.push(worktree)
  }
  for (const row of rows.values()) {
    const lineage = rootLineageByChildId
      .get(row.id)
      ?.find((edge) =>
        edge.childInstanceId
          ? edge.childInstanceId === row.instanceId
          : (row.hostId ?? folderHost) === folderHost
      )
    if (lineage) {
      add(row, lineage.createdAt)
    }
  }
  const folderIdentity = getFolderWorkspaceHostIdentity(folderWorkspace)
  for (const child of crossStoreChildrenByFolderId.get(folderWorkspace.id) ?? []) {
    if (lineageParentIdentities?.get(getWorktreeHostIdentity(child)) !== folderIdentity) {
      continue
    }
    add(
      child,
      getProjectedWorktreeLineage(child, worktreeLineageById)?.createdAt ?? child.createdAt ?? 0
    )
  }
  for (let i = 0; i < queue.length; i++) {
    for (const child of childrenByParent.get(getWorktreeHostIdentity(queue[i])) ?? []) {
      const lineage = getProjectedWorktreeLineage(child, worktreeLineageById)
      add(child, lineage?.createdAt ?? child.createdAt ?? 0)
    }
  }
  const lineageChildrenByParentId = new Map<string, Worktree[]>()
  const nested = new Set<string>()
  for (const identity of members.keys()) {
    const children = (childrenByParent.get(identity) ?? []).filter((child) =>
      members.has(getWorktreeHostIdentity(child))
    )
    if (children.length > 0) {
      children.sort(sortWorktreesByRecentActivity)
      lineageChildrenByParentId.set(identity, children)
      for (const child of children) {
        nested.add(getWorktreeHostIdentity(child))
      }
    }
  }
  const childWorktrees = [...members.values()].map((owner) => owner.worktree)
  childWorktrees.sort(sortWorktreesByRecentActivity)
  const rootChildWorktrees = childWorktrees.filter(
    (row) => !nested.has(getWorktreeHostIdentity(row))
  )
  const owners = [...members.values()].sort(
    (left, right) =>
      left.attachedAt - right.attachedAt ||
      attachedWorktreeOwnerKey(left).localeCompare(attachedWorktreeOwnerKey(right))
  )

  return {
    folderWorkspace,
    childWorktrees,
    owners,
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
      if (child.isArchived || isWorktreeRetiredByRemoval(child) || includedIds.has(child.id)) {
        continue
      }
      includedIds.add(child.id)
      queue.push(child.id)
    }
  }

  const descendantsByParentId = new Map<string, Worktree[]>()
  for (const parentId of includedIds) {
    const children = (projectedChildrenByParentId.get(parentId) ?? []).filter(
      (child) =>
        includedIds.has(child.id) && !child.isArchived && !isWorktreeRetiredByRemoval(child)
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
  if (!worktree || worktree.isArchived || isWorktreeRetiredByRemoval(worktree)) {
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
