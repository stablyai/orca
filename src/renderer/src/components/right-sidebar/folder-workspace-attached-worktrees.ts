import { getLineageInputs } from '../sidebar/visible-worktree-indexes'
import {
  getWorktreeLineageIdentity,
  findWorktreeLineageRow,
  getWorktreeLineageProjection
} from '../../../../shared/sidebar-list/worktree-lineage-projection'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { compareWorktreeDisplayName } from '@/lib/worktree-display-name-order'

export type AttachedWorktreeResolution = {
  folderWorkspace: FolderWorkspace | null
  childWorktrees: Worktree[]
  lineageChildrenByParentId: Map<string, Worktree[]>
  rootChildWorktrees: Worktree[]
}

type AttachedWorktreeResolverArgs = {
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
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
  activeWorkspaceExecutionHostId,
  activeWorkspaceKey,
  activeWorktreeId,
  folderWorkspaces,
  workspaceLineageByChildKey,
  worktreeLineageById,
  worktreesByRepo
}: AttachedWorktreeResolverArgs): AttachedWorktreeResolution {
  const activeScope = parseWorkspaceKey(activeWorkspaceKey ?? activeWorktreeId ?? '')
  const { worktreeMap, lineageById } = getLineageInputs({
    worktreesByRepo,
    folderWorkspaces,
    workspaceLineageByChildKey,
    worktreeLineageById
  })
  const key =
    activeScope?.type === 'folder' ? folderWorkspaceKey(activeScope.folderWorkspaceId) : ''
  const folder = findWorktreeLineageRow(
    worktreeMap,
    activeWorkspaceExecutionHostId
      ? composeWorktreeHostIdentity(activeWorkspaceExecutionHostId, key)
      : key
  )
  const folderWorkspace =
    folder &&
    folderWorkspaces.find(
      (row) =>
        getWorktreeLineageIdentity(folderWorkspaceToWorktree(row)) ===
        getWorktreeLineageIdentity(folder)
    )
  if (!folderWorkspace) {
    return {
      folderWorkspace: null,
      childWorktrees: [],
      lineageChildrenByParentId: new Map(),
      rootChildWorktrees: []
    }
  }

  const { children } = getWorktreeLineageProjection(lineageById, worktreeMap)
  const childWorktrees = (folder ? (children.get(folder) ?? []) : [])
    .filter((row) => !row.isArchived)
    .toSorted(sortWorktreesByRecentActivity)
  const lineageChildrenByParentId = new Map(
    [...children]
      .filter(([parent]) => !parent.id.startsWith('folder:'))
      .map(([parent, rows]) => [
        getWorktreeLineageIdentity(parent),
        rows.filter((row) => !row.isArchived).toSorted(sortWorktreesByRecentActivity)
      ])
  )
  return {
    folderWorkspace,
    childWorktrees,
    lineageChildrenByParentId,
    rootChildWorktrees: childWorktrees
  }
}

function sortWorktreesByRecentActivity(left: Worktree, right: Worktree): number {
  return (
    getWorktreeActivityTime(right) - getWorktreeActivityTime(left) ||
    compareWorktreeDisplayName(left, right)
  )
}
