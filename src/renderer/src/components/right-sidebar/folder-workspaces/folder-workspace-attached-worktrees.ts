import { isWorktreeRetiredByRemoval } from '../../../../../shared/worktree/removal/removal-visibility'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import {
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../../shared/workspace/identity/workspace-scope'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../shared/worktree/lineage-types'
import { getFolderWorkspaceHostIdentity } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import { getProjectedWorktreeLineage } from '../../../../../shared/worktree/lineage/workspace-lineage-graph'
import {
  getFolderWorkspaceChildWorktrees,
  type FolderWorkspaceChildWorktrees
} from '../../../../../shared/folder-workspace-child-worktrees'

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

export type AttachedWorktreeResolution = {
  folderWorkspace: FolderWorkspace | null
  /** Every listed workspace, by when it was attached, for Source Control. */
  owners: AttachedWorktreeOwner[]
} & FolderWorkspaceChildWorktrees

type AttachedWorktreeResolverArgs = {
  executionHostId?: ExecutionHostId | null
  activeWorkspaceKey: string | null
  activeWorktreeId: string | null
  folderWorkspaces: readonly FolderWorkspace[]
  /** selectSidebarChildrenByParentIdentity */
  childrenByParentIdentity: ReadonlyMap<string, readonly Worktree[]>
  /** Date the owners; without them, a workspace's creation time stands in. */
  workspaceLineageByChildKey?: Record<string, WorkspaceLineage>
  worktreeLineageById?: Record<string, WorktreeLineage>
}

export function getAttachedWorktreesForFolderWorkspace({
  executionHostId,
  activeWorkspaceKey,
  activeWorktreeId,
  folderWorkspaces,
  childrenByParentIdentity,
  workspaceLineageByChildKey = {},
  worktreeLineageById = {}
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
      owners: [],
      childWorktrees: [],
      lineageChildrenByParentIdentity: new Map()
    }
  }
  const children = getFolderWorkspaceChildWorktrees(
    getFolderWorkspaceHostIdentity(folderWorkspace),
    childrenByParentIdentity
  )
  const folderHost = getRepoExecutionHostId(folderWorkspace)
  const members = new Map<string, AttachedWorktreeOwner>()
  const add = (worktree: Worktree, attachedAt: number | undefined) => {
    const identity = getWorktreeHostIdentity(worktree)
    if (!members.has(identity) && !isWorktreeRetiredByRemoval(worktree)) {
      members.set(identity, {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        executionHostId: worktree.hostId ?? folderHost,
        worktree,
        attachedAt: attachedAt ?? worktree.createdAt ?? 0
      })
    }
  }
  for (const child of children.childWorktrees) {
    add(child, workspaceLineageByChildKey[worktreeWorkspaceKey(child.id)]?.createdAt)
  }
  for (const nested of children.lineageChildrenByParentIdentity.values()) {
    for (const child of nested) {
      add(child, getProjectedWorktreeLineage(child, worktreeLineageById)?.createdAt)
    }
  }
  const owners = [...members.values()].sort(
    (left, right) =>
      left.attachedAt - right.attachedAt ||
      attachedWorktreeOwnerKey(left).localeCompare(attachedWorktreeOwnerKey(right))
  )
  return { folderWorkspace, owners, ...children }
}
