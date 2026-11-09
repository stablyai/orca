import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { useAppStore } from '@/store'
import { selectKnownWorktreeById } from '@/store/workspaces/selection/known-worktree-selection'

/**
 * Names the workspace a drop went to, for a notice that surfaces while the
 * user is looking at a different one. Undefined when that workspace is active.
 */
export function describeDropWorkspaceIfInactive(
  worktreeId: string,
  worktreePath: string
): string | undefined {
  const state = useAppStore.getState()
  if (state.activeWorktreeId === worktreeId) {
    return undefined
  }
  const worktree = selectKnownWorktreeById(state, worktreeId)
  // Why: a workspace the catalog cannot resolve is still named by its folder.
  const name = (worktree ? resolveWorktreeDisplayName(worktree) : '') || basename(worktreePath)
  if (!name) {
    return undefined
  }
  return translate(
    'auto.components.terminal.pane.terminal.drop.upload.droppedInto',
    'Dropped into {{workspace}}',
    { workspace: name }
  )
}
