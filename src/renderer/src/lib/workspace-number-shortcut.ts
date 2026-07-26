import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

/** Cmd/Ctrl+1–9 target ids come from the rendered sidebar order, which mixes
 *  worktree ids and `folder:` keys — folder keys must go through the guarded
 *  folder path so a missing/unmounted folder blocks activation like a click does. */
export function activateWorkspaceNumberShortcut(workspaceId: string): void {
  const workspaceScope = parseWorkspaceKey(workspaceId)
  if (workspaceScope?.type === 'folder') {
    activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId)
    return
  }
  activateAndRevealWorktree(workspaceId)
}
