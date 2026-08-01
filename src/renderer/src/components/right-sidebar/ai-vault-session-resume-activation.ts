import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { isFloatingWorkspacePanelVisible } from '@/lib/floating-workspace-terminal-actions'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'

export function activateAiVaultResumeWorkspace(workspaceId: string): void {
  const workspaceScope = parseWorkspaceKey(workspaceId)
  if (workspaceScope?.type === 'folder') {
    activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId)
    return
  }

  const worktreeId = workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : workspaceId
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    if (typeof window !== 'undefined' && !isFloatingWorkspacePanelVisible()) {
      window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
    }
    return
  }

  activateAndRevealWorktree(worktreeId)
}
