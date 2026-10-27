import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshStartupWorktrees } from './startup-worktree-refresh'
import type { AllHostRepoCatalogFetchOptions } from '../store/repos/repo-state'

const mocks = vi.hoisted(() => ({ setState: vi.fn() }))
vi.mock('../store', () => ({ useAppStore: { setState: mocks.setState } }))
vi.mock('../store/slices/worktrees/listing/hydrated-worktree-purge', () => ({
  purgeHydratedWorktrees: vi.fn()
}))
vi.mock('./startup-diagnostics', () => ({
  timeRendererStartupStep: (_name: string, operation: () => Promise<unknown>) => operation()
}))

function deferred() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createActions() {
  return {
    fetchAllWorktrees: vi
      .fn<Parameters<typeof refreshStartupWorktrees>[0]['fetchAllWorktrees']>()
      .mockResolvedValue([]),
    awaitOwnerWorktreeVisibilityDefaultsHydration: vi.fn().mockResolvedValue(undefined),
    fetchReposForAllHosts: vi
      .fn<(options?: AllHostRepoCatalogFetchOptions) => Promise<void>>()
      .mockImplementation(async (options) => {
        await options?.onHostLoaded?.('local')
      }),
    fetchProjectGroupsForAllHosts: vi.fn().mockResolvedValue(undefined),
    fetchFolderWorkspacesForAllHosts: vi.fn().mockResolvedValue(undefined),
    pruneLastVisitedTimestamps: vi.fn(),
    fetchWorktreeLineage: vi.fn().mockResolvedValue(undefined)
  }
}

beforeEach(() => vi.clearAllMocks())

describe('startup worktree discovery', () => {
  it('discovers each ready host before slow peers, groups, or default-host settings finish', async () => {
    const visibility = deferred()
    const catalogs = deferred()
    const lineage = deferred()
    const groups = deferred()
    const actions = createActions()
    actions.awaitOwnerWorktreeVisibilityDefaultsHydration.mockReturnValue(visibility.promise)
    actions.fetchProjectGroupsForAllHosts.mockReturnValue(groups.promise)
    actions.fetchReposForAllHosts.mockImplementation(async (options) => {
      await options?.onHostLoaded?.('local')
      await options?.onHostLoaded?.('runtime:healthy')
      await catalogs.promise
      await options?.onHostLoaded?.('runtime:slow')
    })
    actions.fetchWorktreeLineage.mockReturnValue(lineage.promise)

    const refresh = refreshStartupWorktrees(actions, () => false)
    expect(actions.fetchAllWorktrees).toHaveBeenCalledExactlyOnceWith({
      visibilityOwnerHostId: 'local',
      hydrationPurge: 'defer'
    })
    await vi.waitFor(() => expect(actions.fetchAllWorktrees).toHaveBeenCalledTimes(2))
    expect(mocks.setState).not.toHaveBeenCalled()
    expect(actions.fetchFolderWorkspacesForAllHosts).not.toHaveBeenCalled()
    expect(actions.fetchAllWorktrees.mock.calls[1]).toEqual([
      { visibilityOwnerHostId: 'runtime:healthy', hydrationPurge: 'defer' }
    ])

    visibility.resolve()
    groups.resolve()

    catalogs.resolve()
    await vi.waitFor(() =>
      expect(mocks.setState).toHaveBeenCalledWith({ startupWorktreeRefreshCompleted: true })
    )
    expect(actions.fetchAllWorktrees.mock.calls).toEqual([
      [{ visibilityOwnerHostId: 'local', hydrationPurge: 'defer' }],
      [{ visibilityOwnerHostId: 'runtime:healthy', hydrationPurge: 'defer' }],
      [{ visibilityOwnerHostId: 'runtime:slow', hydrationPurge: 'defer' }]
    ])
    expect(actions.fetchFolderWorkspacesForAllHosts).toHaveBeenCalledOnce()
    expect(actions.pruneLastVisitedTimestamps).toHaveBeenCalledOnce()
    expect(actions.fetchWorktreeLineage).toHaveBeenCalledOnce()
    lineage.resolve()
    await refresh
  })

  it('does not leave discovery pending when remote catalogs fail', async () => {
    const actions = createActions()
    actions.fetchReposForAllHosts.mockRejectedValue(new Error('offline'))
    await refreshStartupWorktrees(actions, () => false)
    expect(actions.fetchAllWorktrees).toHaveBeenCalledTimes(1)
    expect(mocks.setState).toHaveBeenCalledWith({ startupWorktreeRefreshCompleted: true })
  })

  it('stops admitting work and publishing completion after teardown', async () => {
    const visibility = deferred()
    const actions = createActions()
    actions.fetchReposForAllHosts.mockImplementation(async (options) => {
      await visibility.promise
      await options?.onHostLoaded?.('runtime:late')
    })
    let cancelled = false
    const refresh = refreshStartupWorktrees(actions, () => cancelled)
    cancelled = true
    visibility.resolve()
    await refresh
    expect(actions.fetchAllWorktrees).toHaveBeenCalledTimes(1)
    expect(mocks.setState).not.toHaveBeenCalled()
    expect(actions.fetchWorktreeLineage).not.toHaveBeenCalled()
  })
})
