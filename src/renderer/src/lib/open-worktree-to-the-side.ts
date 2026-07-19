import { useAppStore } from '@/store'
import type { WorkspacePaneOpenEdge } from '@/store/slices/workspace-split-view'
import { workspaceSplitContainsPane } from '@/store/slices/workspace-split-view'
import { activateAndRevealWorktree } from './worktree-activation'

/**
 * Open a worktree as a side-by-side pane next to the current view, then focus
 * it. The pane assignment happens first so the activation's setActiveWorktree
 * sees the target already visible and only moves focus (no leaf replacement).
 */
export function openWorktreeToTheSide(
  worktreeId: string,
  opts?: { targetWorktreeId?: string; edge?: WorkspacePaneOpenEdge }
): boolean {
  const state = useAppStore.getState()
  if (state.settings?.experimentalSideBySideWorkspaces !== true) {
    return false
  }
  const alreadyVisible =
    workspaceSplitContainsPane(state.workspaceSplitLayout, worktreeId) ||
    (!state.workspaceSplitLayout && state.activeWorktreeId === worktreeId)
  if (!alreadyVisible && !state.openWorkspacePane(worktreeId, opts)) {
    // Why: a center-drop on the single full-width view has no pane to swap —
    // it degrades to a plain activation. Any other rejection aborts.
    const replaceWithoutSplit = (opts?.edge ?? 'right') === 'replace' && !state.workspaceSplitLayout
    if (!replaceWithoutSplit) {
      return false
    }
  }
  // Why: reuse the canonical activation for focus, visit recency, agent-session
  // resume, and the initial terminal — a side pane needs all of them too.
  return activateAndRevealWorktree(worktreeId, { revealInSidebar: false }) !== false
}
