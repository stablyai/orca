import { isViewEntry } from '@/store/slices/ui/workspace-navigation-history'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'

export function reopenClosedWorkspaceTab(activeWorktreeId: string | null): void {
  const state = useAppStore.getState()
  // Closing the last tab lands on welcome without discarding the workspace navigation entry.
  const previous = state.worktreeNavHistory[state.worktreeNavHistoryIndex]
  const worktreeId =
    activeWorktreeId ?? (typeof previous === 'string' && !isViewEntry(previous) ? previous : null)
  if (!worktreeId || !state.reopenClosedTab(worktreeId)) {
    return
  }
  if (!activeWorktreeId) {
    // History entries may be folder workspace keys; this is the activator history replay uses.
    activateAndRevealWorkspace(worktreeId)
  }
}
