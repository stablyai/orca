import type { ExecutionHostId } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceLinkedItem, Worktree } from '../../../shared/worktree/types'

export type KanbanWorktreeCandidate = Pick<
  Worktree,
  'id' | 'isArchived' | 'linkedWorkItem' | 'hostId'
>

export type KanbanFolderWorkspaceCandidate = Pick<
  FolderWorkspace,
  'id' | 'isArchived' | 'linkedTask' | 'executionHostId'
>

export type KanbanTaskWorkspaceLink =
  | {
      kind: 'worktree'
      workspaceId: string
      executionHostId: ExecutionHostId | null
      worktree: KanbanWorktreeCandidate
    }
  | {
      kind: 'folder'
      workspaceId: string
      executionHostId: ExecutionHostId | null
      folderWorkspace: KanbanFolderWorkspaceCandidate
    }

// Why: the exact linked Kanban id is the only link identity that counts; a
// legacy GitHub/Jira item or a different card id must never resume this card.
function isKanbanTaskLink(
  item: WorkspaceLinkedItem | null | undefined,
  taskId: string
): boolean {
  return item?.provider === 'kanban' && item.kanbanIdentifier === taskId
}

/**
 * Find the existing workspace already linked to this Kanban card. Scans
 * current worktrees first, then folder workspaces, skipping archived ones.
 * Returns the workspace id ready for `activateAndRevealWorkspace`, carrying
 * the owner's execution host so activation resolves the right owner even when
 * a local and an SSH workspace share the same id.
 */
export function findKanbanTaskWorkspaceLink({
  worktrees,
  folderWorkspaces,
  taskId
}: {
  worktrees: readonly KanbanWorktreeCandidate[]
  folderWorkspaces: readonly KanbanFolderWorkspaceCandidate[]
  taskId: string
}): KanbanTaskWorkspaceLink | null {
  const worktree = worktrees.find(
    (candidate) => !candidate.isArchived && isKanbanTaskLink(candidate.linkedWorkItem, taskId)
  )
  if (worktree) {
    return {
      kind: 'worktree',
      workspaceId: worktree.id,
      executionHostId: worktree.hostId ?? null,
      worktree
    }
  }
  const folderWorkspace = folderWorkspaces.find(
    (candidate) =>
      !candidate.isArchived && isKanbanTaskLink(candidate.linkedTask, taskId)
  )
  if (folderWorkspace) {
    return {
      kind: 'folder',
      workspaceId: folderWorkspaceKey(folderWorkspace.id),
      executionHostId: folderWorkspace.executionHostId ?? null,
      folderWorkspace
    }
  }
  return null
}