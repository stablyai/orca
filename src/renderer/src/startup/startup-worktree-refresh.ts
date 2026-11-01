import type { StartupActions } from '../app-shell/startup-actions-selector'
import { useAppStore } from '../store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { purgeHydratedWorktrees } from '../store/slices/worktrees/listing/hydrated-worktree-purge'
import type { WorktreeRefreshResult } from '../store/slices/worktrees/listing/worktree-refresh-result'
import { timeRendererStartupStep } from './startup-diagnostics'

type WorktreeRefreshActions = Pick<
  StartupActions,
  | 'fetchAllWorktrees'
  | 'awaitOwnerWorktreeVisibilityDefaultsHydration'
  | 'fetchReposForAllHosts'
  | 'fetchProjectGroupsForAllHosts'
  | 'fetchFolderWorkspacesForAllHosts'
  | 'pruneLastVisitedTimestamps'
  | 'fetchWorktreeLineage'
>

export function finishStartupWorktreeHydration(results: readonly WorktreeRefreshResult[]): void {
  purgeHydratedWorktrees(useAppStore.setState, useAppStore.getState, results)
}

export async function refreshStartupWorktrees(
  actions: WorktreeRefreshActions,
  isCancelled: () => boolean
): Promise<WorktreeRefreshResult[]> {
  const results: WorktreeRefreshResult[] = []
  if (isCancelled()) {
    return results
  }
  const refreshedHosts = new Set<ExecutionHostId>()
  const refreshHost = async (hostId: ExecutionHostId): Promise<void> => {
    if (isCancelled() || refreshedHosts.has(hostId)) {
      return
    }
    refreshedHosts.add(hostId)
    try {
      const refreshed = await timeRendererStartupStep(
        'host-worktree-refresh',
        () => actions.fetchAllWorktrees({ visibilityOwnerHostId: hostId, hydrationPurge: 'defer' }),
        { hostId }
      )
      results.push(...refreshed)
    } catch (err) {
      console.warn(`Startup worktree refresh failed for host ${hostId}:`, err)
    }
  }
  const localRefresh = refreshHost('local')
  let catalogsSucceeded = true
  try {
    const outcomes = await Promise.allSettled([
      timeRendererStartupStep('owner-visibility-defaults', () =>
        actions.awaitOwnerWorktreeVisibilityDefaultsHydration()
      ),
      timeRendererStartupStep('remote-catalog-refresh', () =>
        actions.fetchReposForAllHosts({
          // Each catalog installs its host's visibility policy before this callback.
          onHostLoaded: (hostId) => (hostId === 'local' ? localRefresh : refreshHost(hostId))
        })
      ),
      timeRendererStartupStep('workspace-catalog-refresh', async () => {
        await actions.fetchProjectGroupsForAllHosts()
        if (!isCancelled()) {
          await actions.fetchFolderWorkspacesForAllHosts()
        }
      }),
      localRefresh
    ])
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        catalogsSucceeded = false
        console.warn('Startup workspace catalog refresh failed:', outcome.reason)
      }
    }
    if (!isCancelled()) {
      actions.pruneLastVisitedTimestamps()
    }
  } finally {
    if (!isCancelled()) {
      useAppStore.setState({ startupWorktreeRefreshCompleted: true })
    }
  }
  if (!isCancelled()) {
    // Lineage decorates rows; it must not keep discovery feedback pending.
    void actions.fetchWorktreeLineage().catch((err: unknown) => {
      console.warn('Startup worktree lineage refresh failed:', err)
    })
  }
  return catalogsSucceeded ? results : []
}
