import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'

const BACKGROUND_OPEN_TOAST_ID = 'source-control-background-open'

/**
 * A lineage section opens files in its own worktree, which is not the one on screen, so the editor
 * shows nothing new. Tell the user where it went and offer the switch. No-op for the active worktree.
 */
export function notifySourceControlBackgroundOpen(worktreeId: string): void {
  const state = useAppStore.getState()
  if (state.activeWorktreeId === worktreeId) {
    return
  }
  const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
  const label = worktree?.displayName || (worktree ? basename(worktree.path) : worktreeId)
  toast(
    translate(
      'auto.components.right.sidebar.SourceControl.openedInWorkspace',
      'Opened in {{value0}}',
      { value0: label }
    ),
    {
      id: BACKGROUND_OPEN_TOAST_ID,
      action: {
        label: translate('auto.components.right.sidebar.SourceControl.switchToWorkspace', 'Switch'),
        onClick: () => {
          if (!activateAndRevealWorktree(worktreeId)) {
            toast.error(
              translate(
                'auto.components.right.sidebar.AiVaultPanel.worktreeUnavailable',
                'Worktree is no longer available.'
              )
            )
          }
        }
      }
    }
  )
}
