import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'

// Tear down panes + bindings + prefetch lock so the next activation
// re-runs the declarative seed against the latest orca.yaml.
export async function runResetWorktreeLayout(worktreeId: string): Promise<void> {
  const state = useAppStore.getState()
  const wasActive = state.activeWorktreeId === worktreeId
  if (wasActive) {
    state.setActiveWorktree(null)
  }
  try {
    // Why: Sleep teardown order — browsers before PTYs (matches removeWorktree).
    await state.shutdownWorktreeBrowsers(worktreeId)
    await state.shutdownWorktreeTerminals(worktreeId)

    // Why: prefetch dedup is per-session, outside purge scope — clear
    // here or fetchWorktrees skips the IPC and seed gets no config.
    state.purgeWorktreeTerminalState([worktreeId])
    useAppStore.setState((s) => {
      if (!s.layoutConfigPrefetchedIds.has(worktreeId)) {
        return s
      }
      const next = new Set(s.layoutConfigPrefetchedIds)
      next.delete(worktreeId)
      return { layoutConfigPrefetchedIds: next }
    })

    // Why: re-fetch unblocks the prefetch loop; activateAndRevealWorktree
    // (not setActiveWorktree) is the path that runs seedLayoutFromStore.
    const repoId = worktreeId.split('::')[0]
    if (repoId) {
      await useAppStore.getState().fetchWorktrees(repoId)
    }
    if (wasActive) {
      activateAndRevealWorktree(worktreeId)
    }
  } catch (err) {
    toast.error('Failed to reset workspace layout', {
      description: err instanceof Error ? err.message : String(err)
    })
  }
}
