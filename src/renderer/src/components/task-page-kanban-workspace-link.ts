import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceLinkedItem, Worktree } from '../../../shared/worktree/types'

export type KanbanWorktreeCandidate = Pick<Worktree, 'id' | 'isArchived' | 'linkedWorkItem'>

export type KanbanFolderWorkspaceCandidate = Pick<
  FolderWorkspace,
  'id' | 'isArchived' | 'linkedTask'
>

export type KanbanTaskWorkspaceLink =
  | { kind: 'worktree'; workspaceId: string; worktree: KanbanWorktreeCandidate }
  | { kind: 'folder'; workspaceId: string; folderWorkspace: KanbanFolderWorkspaceCandidate }

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
 * Returns the workspace id ready for `activateAndRevealWorkspace`.
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
    return { kind: 'worktree', workspaceId: worktree.id, worktree }
  }
  const folderWorkspace = folderWorkspaces.find(
    (candidate) =>
      !candidate.isArchived && isKanbanTaskLink(candidate.linkedTask, taskId)
  )
  if (folderWorkspace) {
    return {
      kind: 'folder',
      workspaceId: folderWorkspaceKey(folderWorkspace.id),
      folderWorkspace
    }
  }
  return null
}