import type { StartupActions } from '../app-shell/startup-actions-selector'
import { useAppStore } from '../store'
import { timeRendererStartupStep } from './startup-diagnostics'

export async function refreshDeferredStartupCatalog(
  actions: StartupActions,
  isCancelled: () => boolean
): Promise<void> {
  try {
    try {
      // Why: remote rows must not render under a fallback visibility while their owner default is still loading.
      await timeRendererStartupStep('owner-visibility-defaults', () =>
        actions.awaitOwnerWorktreeVisibilityDefaultsHydration()
      )
      await timeRendererStartupStep('remote-catalog-refresh', async () => {
        await actions.fetchReposForAllHosts()
        await actions.fetchProjectGroupsForAllHosts()
        await actions.fetchFolderWorkspacesForAllHosts()
      })
    } catch (err) {
      console.warn('Remote startup catalog refresh failed:', err)
    }
    if (!isCancelled()) {
      try {
        await timeRendererStartupStep('remote-worktree-refresh', async () => {
          // Why: the full scan is not required for session recovery, so keep it off the startup-critical path.
          await actions.fetchAllWorktrees()
          // Why: the startup prune only saw session-referenced repos; use the deferred scan's
          // authoritative results to drop deleted-worktree visit timestamps that would
          // otherwise accumulate unbounded (disconnected SSH stays non-authoritative and is kept).
          actions.pruneLastVisitedTimestamps()
          await actions.fetchWorktreeLineage()
        })
      } catch (err) {
        console.warn('Deferred startup worktree refresh failed:', err)
      }
    }
  } finally {
    if (!isCancelled()) {
      useAppStore.setState({ startupWorktreeRefreshCompleted: true })
    }
  }
}
