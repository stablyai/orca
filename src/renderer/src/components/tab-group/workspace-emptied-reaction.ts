import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { armFloatingPanelReclaimIntent } from '@/lib/floating-workspace-focus-reclaim'
import { isFloatingWorkspacePanelFocused } from '@/lib/floating-workspace-terminal-actions'
import { selectFloatingVisibleTabCount } from '@/store/selectors'

/** Capture panel ownership before prompts/removal blur it; run the captured reaction only after the close lands. */
export function captureWorkspaceEmptiedReaction(
  worktreeId: string,
  options?: { floatingPanelGuestOwned?: boolean }
): () => void {
  // Emptying the floating panel retains keyboard ownership; emptying a worktree leaves that worktree.
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    const panelOwned =
      options?.floatingPanelGuestOwned === true || isFloatingWorkspacePanelFocused()
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
