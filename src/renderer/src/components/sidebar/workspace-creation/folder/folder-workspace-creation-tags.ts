import { useAppStore } from '@/store'
import { persistCreationMetadata } from '@/lib/workspace/creation/worktree-creation-meta'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'

/** Writes the composer's tags onto a just-created folder workspace; folder creates carry no tags themselves. */
export function persistFolderWorkspaceCreationTags(
  workspace: FolderWorkspace,
  tags: readonly string[]
): void {
  if (tags.length === 0) {
    return
  }
  const folderWorktree = folderWorkspaceToWorktree(workspace)
  // Why: same route the Tags menu uses, so tags land on the host that owns the folder; not awaited so the handoff stays fast.
  void persistCreationMetadata({
    worktreeId: folderWorktree.id,
    workspaceName: workspace.name,
    note: undefined,
    tags: [...tags],
    write: (worktreeId, updates) =>
      useAppStore.getState().updateWorktreeMeta(worktreeId, updates, {
        executionHostId: folderWorktree.hostId ?? 'local'
      })
  })
}
