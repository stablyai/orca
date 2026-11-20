import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import { getFolderWorkspaceWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'

export function projectWorkspaceBoardFolders(args: {
  folders: readonly FolderWorkspace[]
  childrenByParentIdentity: ReadonlyMap<string, readonly Worktree[]>
  visibleHostIds: ReadonlySet<ExecutionHostId> | null
  visibleGitIdentities: ReadonlySet<string>
}): { folders: Worktree[]; visibleIdentities: ReadonlySet<string> } {
  const folders: Worktree[] = []
  const visibleIdentities = new Set(args.visibleGitIdentities)
  for (const folder of args.folders) {
    if (folder.isArchived) {
      continue
    }
    const card = getFolderWorkspaceWorktree(folder)
    if (args.visibleHostIds && !args.visibleHostIds.has(card.hostId ?? 'local')) {
      continue
    }
    folders.push(card)
    const identity = getWorktreeHostIdentity(card)
    visibleIdentities.add(identity)
    for (const child of args.childrenByParentIdentity.get(identity) ?? []) {
      if (parseWorkspaceKey(child.id)?.type !== 'folder') {
        visibleIdentities.delete(getWorktreeHostIdentity(child))
      }
    }
  }
  return { folders, visibleIdentities }
}
