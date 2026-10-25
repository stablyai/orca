import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { armFloatingPanelReclaimIntent } from '@/lib/floating-workspace-focus-reclaim'
import { isFloatingWorkspacePanelFocused } from '@/lib/floating-workspace-terminal-actions'
import { selectFloatingVisibleTabCount } from '@/store/selectors'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  captureLastTabAutoDeleteCandidate,
  type LastTabAutoDeleteTrigger
} from '@/lib/last-tab-auto-delete/last-tab-auto-delete-candidate'
import { enqueueLastTabAutoDelete } from '@/lib/last-tab-auto-delete/last-tab-auto-delete-queue'

/** Capture panel ownership before prompts/removal blur it; run the captured reaction only after the close lands. */
export function captureWorkspaceEmptiedReaction(
  worktreeId: string,
  options?: {
    floatingPanelGuestOwned?: boolean
    trigger?: LastTabAutoDeleteTrigger
    /** False when no user asked for the close (a page calling window.close()). */
    autoDeleteEligible?: boolean
    hostId?: ExecutionHostId
    /** False keeps the selection: a parked terminal's exit never deselected its workspace. */
    leaveIfEmpty?: boolean
  }
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
  const candidate =
    options?.autoDeleteEligible === false
      ? null
      : captureLastTabAutoDeleteCandidate(useAppStore.getState(), worktreeId, {
          trigger: options?.trigger ?? 'close',
          ...(options?.hostId ? { hostId: options.hostId } : {})
        })
  return () => {
    if (options?.leaveIfEmpty !== false) {
      leaveWorktreeIfEmpty(worktreeId)
    }
    if (candidate) {
      enqueueLastTabAutoDelete(candidate)
    }
  }
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
