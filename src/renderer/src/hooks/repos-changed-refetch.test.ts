import { describe, expect, it, vi } from 'vitest'
import {
  createReposChangedRefetchRunner,
  type ReposChangedRefetchActions
} from './repos-changed-refetch'

type Deferred = { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function noopActions(): ReposChangedRefetchActions {
  return {
    fetchRepos: vi.fn(async () => {}),
    fetchProjectGroups: vi.fn(async () => {}),
    fetchFolderWorkspaces: vi.fn(async () => {}),
    fetchReposForAllHosts: vi.fn(async () => {}),
    fetchProjectGroupsForAllHosts: vi.fn(async () => {}),
    fetchFolderWorkspacesForAllHosts: vi.fn(async () => {})
  }
}

describe('createReposChangedRefetchRunner', () => {
  it('coalesces a burst of events into a single trailing refetch', async () => {
    const pending: Deferred[] = []
    const actions = noopActions()
    actions.fetchRepos = vi.fn(() => {
      const d = deferred()
      pending.push(d)
      return d.promise
    })
    const runner = createReposChangedRefetchRunner({
      isRuntimeEnvironmentActive: () => false,
      getActions: () => actions
    })

    // First event starts a refetch that stays in flight.
    runner.run()
    expect(actions.fetchRepos).toHaveBeenCalledTimes(1)

    // A burst of further events while the first refetch is in flight collapses
    // into a single pending rerun rather than N overlapping fetches.
    runner.run()
    runner.run()
    runner.run()
    expect(actions.fetchRepos).toHaveBeenCalledTimes(1)

    // Completing the in-flight refetch triggers exactly one trailing refetch,
    // which is the one that reads the final settled state.
    pending[0].resolve()
    await flush()
    expect(actions.fetchRepos).toHaveBeenCalledTimes(2)

    // No further events arrived, so the trailing refetch does not chain another.
    pending[1].resolve()
    await flush()
    expect(actions.fetchRepos).toHaveBeenCalledTimes(2)
  })

  it('runs immediately for a single isolated event', async () => {
    const actions = noopActions()
    const runner = createReposChangedRefetchRunner({
      isRuntimeEnvironmentActive: () => false,
      getActions: () => actions
    })

    runner.run()
    await flush()

    expect(actions.fetchProjectGroups).toHaveBeenCalledTimes(1)
    expect(actions.fetchFolderWorkspaces).toHaveBeenCalledTimes(1)
    expect(actions.fetchRepos).toHaveBeenCalledTimes(1)
  })

  it('refreshes every host when a runtime environment is active', async () => {
    const actions = noopActions()
    const runner = createReposChangedRefetchRunner({
      isRuntimeEnvironmentActive: () => true,
      getActions: () => actions
    })

    runner.run()
    await flush()

    expect(actions.fetchReposForAllHosts).toHaveBeenCalledTimes(1)
    expect(actions.fetchProjectGroupsForAllHosts).toHaveBeenCalledTimes(1)
    expect(actions.fetchFolderWorkspacesForAllHosts).toHaveBeenCalledTimes(1)
    expect(actions.fetchRepos).not.toHaveBeenCalled()
  })

  it('drops a queued trailing refetch once disposed', async () => {
    const pending: Deferred[] = []
    const actions = noopActions()
    actions.fetchRepos = vi.fn(() => {
      const d = deferred()
      pending.push(d)
      return d.promise
    })
    const runner = createReposChangedRefetchRunner({
      isRuntimeEnvironmentActive: () => false,
      getActions: () => actions
    })

    runner.run()
    runner.run() // queue a trailing rerun while in flight
    runner.dispose()
    pending[0].resolve()
    await flush()

    expect(actions.fetchRepos).toHaveBeenCalledTimes(1)
  })
})
