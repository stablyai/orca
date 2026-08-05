import type { AppState } from '@/store/types'

export function activateTerminalInitiatedWorktree(store: AppState, worktreeId: string): void {
  store.setActiveView('terminal')
  store.setActiveWorktree(worktreeId)
  // Why: CLI/runtime terminal focus is user-visible navigation, so feed both worktree-palette recency and the back/forward stack.
  store.markWorktreeVisited(worktreeId)
  if (!store.isNavigatingHistory) {
    store.recordWorktreeVisit(worktreeId)
  }
}
