import { useAppStore } from '@/store'

/**
 * Resolve the SSH connectionId for a worktree. Returns null for local repos,
 * the target ID string for remote repos, or undefined if the worktree/repo
 * cannot be found (e.g., store not yet hydrated).
 */
export function getConnectionId(worktreeId: string | null): string | null | undefined {
  if (!worktreeId) {
    return null
  }
  const state = useAppStore.getState()
  const allWorktrees = Object.values(state.worktreesByRepo ?? {}).flat()
  const worktree = allWorktrees.find((w) => w.id === worktreeId)
  if (!worktree) {
    return undefined
  }
  const repo = state.repos?.find((r) => r.id === worktree.repoId)
  return repo?.connectionId ?? null
}
