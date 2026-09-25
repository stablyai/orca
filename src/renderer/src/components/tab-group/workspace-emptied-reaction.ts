import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { armFloatingPanelReclaimIntent } from '@/lib/floating-workspace-focus-reclaim'
import { isFloatingWorkspacePanelFocused } from '@/lib/floating-workspace-terminal-actions'
import { selectFloatingVisibleTabCount } from '@/store/selectors'

/**
 * What a close does if it leaves its workspace with no tabs. Capture it when the close is requested
 * and run it once the close lands: removing the focused pane blurs it, so panel ownership has to be
 * read up front.
 */
export function captureWorkspaceEmptiedReaction(worktreeId: string): () => void {
  // Why per workspace: an emptied worktree is left, but the floating panel is never the active
  // worktree — emptying it from inside instead keeps keyboard ownership for the next Cmd/Ctrl+T.
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    const panelOwned = isFloatingWorkspacePanelFocused()
    return () => {
      if (panelOwned && selectFloatingVisibleTabCount(useAppStore.getState()) === 0) {
        armFloatingPanelReclaimIntent()
      }
    }
  }
  return () => leaveWorktreeIfEmpty(worktreeId)
}

function leaveWorktreeIfEmpty(worktreeId: string): void {
  const state = useAppStore.getState()
  if (state.activeWorktreeId !== worktreeId) {
    return
  }
  // Why: split-group closes bypass legacy Terminal.tsx; deselect the emptied worktree here or the window goes blank instead of landing.
  if (state.reconcileWorktreeTabModel(worktreeId).renderableTabCount === 0) {
    state.setActiveWorktree(null)
  }
}
