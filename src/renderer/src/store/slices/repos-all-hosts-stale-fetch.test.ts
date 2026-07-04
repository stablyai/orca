import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Repo } from '../../../../shared/types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2
}

const reposList = vi.fn()
const runtimeEnvironmentsList = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset()
  runtimeEnvironmentsList.mockReset()
  // No runtime environments configured, so the all-host load only exercises the
  // local slice. Only repos.list is stubbed — the missing projects API makes
  // fetchProjectHostSetupCompatibility fall back to deriving from repos.
  runtimeEnvironmentsList.mockResolvedValue([])
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      runtimeEnvironments: { list: runtimeEnvironmentsList }
    }
  })
})

// The runtime-active sidebar refreshes via fetchReposForAllHosts, and a
// repos:changed burst (deleting a project group with contained projects) fires
// it N+1 times. Unlike fetchRepos, this path had no stale-fetch guard (#7024
// scoped its generation guard to fetchRepos), so overlapping all-host loads
// could resolve out of order and resurrect removed projects (#7020). The
// single-flight coalescing must keep the sidebar on the final persisted state.
describe('fetchReposForAllHosts stale-fetch race (#7020)', () => {
  it('coalesces a burst into one trailing reload that reads the final state', async () => {
    const store = createTestStore()
    let resolveLeading!: (repos: Repo[]) => void
    const leadingPromise = new Promise<Repo[]>((resolve) => {
      resolveLeading = resolve
    })
    // Why: the leading load reads pre-removal state (both repos) but resolves
    // LAST; the single trailing reload reads post-removal state (remoteRepo gone).
    reposList.mockReturnValueOnce(leadingPromise).mockResolvedValueOnce([localRepo])

    const leading = store.getState().fetchReposForAllHosts()
    // Further burst events while the leading load is in flight collapse into a
    // single pending trailing reload rather than starting overlapping loads.
    const coalescedA = store.getState().fetchReposForAllHosts()
    const coalescedB = store.getState().fetchReposForAllHosts()
    await coalescedA
    await coalescedB
    // Only the leading load has hit the network so far; the burst was absorbed.
    expect(reposList).toHaveBeenCalledTimes(1)

    resolveLeading([localRepo, remoteRepo])
    await leading

    // Leading (both repos) + exactly one trailing reload — not one load per event.
    expect(reposList).toHaveBeenCalledTimes(2)
    // The trailing reload's post-removal read wins, so the removed project is gone.
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo'])
    expect(store.getState().reposAllHostsLoadInFlight).toBe(false)
    expect(store.getState().reposAllHostsReloadRequested).toBe(false)
  })

  it('runs immediately for an isolated event', async () => {
    const store = createTestStore()
    reposList.mockResolvedValueOnce([localRepo])

    await store.getState().fetchReposForAllHosts()

    expect(reposList).toHaveBeenCalledTimes(1)
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo'])
    expect(store.getState().reposAllHostsLoadInFlight).toBe(false)
  })
})
