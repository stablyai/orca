import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getAttachedWorktreesByFolderWorkspaceId } from './worktree-list/grouping/folder-workspace-attached'

/**
 * The worktree-shaped rows the Workspace Board lays out: every git worktree
 * except those attached to a folder workspace on the board, plus each live
 * folder workspace projected through the same adapter the sidebar uses. An
 * attached worktree is part of its ticket's card, so the ticket — not the
 * branch — is what moves between columns.
 */
export function buildWorkspaceBoardWorktrees(args: {
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
}): Worktree[] {
  const folderWorkspaces = args.folderWorkspaces.filter((workspace) => !workspace.isArchived)
  const attachedByFolderId = getAttachedWorktreesByFolderWorkspaceId(
    args.worktrees,
    args.workspaceLineageByChildKey
  )
  // Why: a worktree id is `repoId::path` with no host component, so two hosts can publish the same
  // id for two different workspaces. Folding on the bare id dropped both rows when only one of them
  // was attached; the grouping already returns the host-specific child, so key on its identity.
  const attachedIdentities = new Set(
    folderWorkspaces.flatMap((workspace) =>
      (attachedByFolderId.get(workspace.id) ?? []).map(getWorktreeHostIdentity)
    )
  )
  return [
    ...args.worktrees.filter(
      (worktree) => !attachedIdentities.has(getWorktreeHostIdentity(worktree))
    ),
    ...folderWorkspaces.map(folderWorkspaceToWorktree)
  ]
}
