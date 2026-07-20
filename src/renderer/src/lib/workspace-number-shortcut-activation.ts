import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

export function activateWorkspaceNumberShortcut(workspaceId: string): void {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    // Folder activation performs path/runtime checks that ordinary worktrees do not need.
    activateAndRevealFolderWorkspace(scope.folderWorkspaceId)
    return
  }

  activateAndRevealWorktree(scope?.type === 'worktree' ? scope.worktreeId : workspaceId)
}
