// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { selectStartupActions } from '../app-shell/startup-actions-selector'
import { useAppStore } from '../store'
import { refreshDeferredStartupCatalog } from './startup-deferred-catalog-refresh'

function createCatalogActions() {
  return {
    ...selectStartupActions(useAppStore.getState()),
    awaitOwnerWorktreeVisibilityDefaultsHydration: vi.fn(async () => {}),
    fetchReposForAllHosts: vi.fn(async () => {}),
    fetchProjectGroupsForAllHosts: vi.fn(async () => {}),
    fetchFolderWorkspacesForAllHosts: vi.fn(async () => {}),
    fetchAllWorktrees: vi.fn(async () => {}),
    pruneLastVisitedTimestamps: vi.fn(),
    fetchWorktreeLineage: vi.fn(async () => {})
  }
}

beforeEach(() => useAppStore.setState({ startupWorktreeRefreshCompleted: false }))

it('waits for owner visibility before refreshing git and folder catalogs, then releases the refresh gate', async () => {
  const defaults = Promise.withResolvers<void>()
  const actions = createCatalogActions()
  actions.awaitOwnerWorktreeVisibilityDefaultsHydration.mockReturnValue(defaults.promise)
  const refresh = refreshDeferredStartupCatalog(actions, () => false)
  expect(actions.fetchReposForAllHosts).not.toHaveBeenCalled()
  expect(actions.fetchFolderWorkspacesForAllHosts).not.toHaveBeenCalled()
  expect(useAppStore.getState().startupWorktreeRefreshCompleted).toBe(false)
  defaults.resolve()
  await refresh
  expect(actions.fetchReposForAllHosts).toHaveBeenCalledBefore(
    actions.fetchProjectGroupsForAllHosts
  )
  expect(actions.fetchProjectGroupsForAllHosts).toHaveBeenCalledBefore(
    actions.fetchFolderWorkspacesForAllHosts
  )
  expect(actions.fetchFolderWorkspacesForAllHosts).toHaveBeenCalledBefore(actions.fetchAllWorktrees)
  expect(actions.fetchAllWorktrees).toHaveBeenCalledBefore(actions.pruneLastVisitedTimestamps)
  expect(actions.pruneLastVisitedTimestamps).toHaveBeenCalledBefore(actions.fetchWorktreeLineage)
  expect(useAppStore.getState().startupWorktreeRefreshCompleted).toBe(true)
})

it.each(['visibility', 'worktrees'] as const)(
  'cancellation during %s leaves refresh completion to the next startup owner',
  async (phase) => {
    const pending = Promise.withResolvers<void>()
    const actions = createCatalogActions()
    let cancelled = false
    if (phase === 'visibility') {
      actions.awaitOwnerWorktreeVisibilityDefaultsHydration.mockReturnValue(pending.promise)
    } else {
      actions.fetchAllWorktrees.mockImplementation(() => {
        cancelled = true
        return pending.promise
      })
    }
    const refresh = refreshDeferredStartupCatalog(actions, () => cancelled)
    cancelled = phase === 'visibility'
    pending.resolve()
    await refresh
    expect(actions.fetchReposForAllHosts).toHaveBeenCalledTimes(1)
    expect(actions.fetchAllWorktrees).toHaveBeenCalledTimes(phase === 'visibility' ? 0 : 1)
    expect(useAppStore.getState().startupWorktreeRefreshCompleted).toBe(false)
  }
)

it.each(['catalog', 'worktrees'] as const)(
  'a failed %s refresh reports the failure and releases the gate',
  async (phase) => {
    const actions = createCatalogActions()
    const failure = new Error('host unavailable')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (phase === 'catalog') {
      actions.fetchReposForAllHosts.mockRejectedValue(failure)
    } else {
      actions.fetchAllWorktrees.mockRejectedValue(failure)
    }
    try {
      await refreshDeferredStartupCatalog(actions, () => false)
      expect(actions.fetchAllWorktrees).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.any(String), failure)
      expect(useAppStore.getState().startupWorktreeRefreshCompleted).toBe(true)
    } finally {
      warn.mockRestore()
    }
  }
)
