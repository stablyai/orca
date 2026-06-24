import { useAppStore } from '@/store'

// Why: several right-sidebar panels (Source Control, Checks) are branch/PR-centric
// and don't apply to an Orcastrator's coordination worktree — it has no branch or
// PR of its own. Shared so every panel decides "is the active worktree a director?"
// from one rule instead of re-deriving it.
export function useIsOrchestratorActiveWorktree(): boolean {
  return useAppStore((s) => {
    const activeWorktreeId = s.activeWorktreeId
    return activeWorktreeId
      ? (s.orchestrators ?? []).some((entry) => entry.worktreeId === activeWorktreeId)
      : false
  })
}
