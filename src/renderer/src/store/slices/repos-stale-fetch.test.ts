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

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset()
  // Only repos.list is exercised here — the missing projects API makes
  // fetchProjectHostSetupCompatibility fall back to deriving from repos.
  vi.stubGlobal('window', { api: { repos: { list: reposList } } })
})

// A repos:changed burst (deleting a project group with contained projects) starts
// overlapping fetchRepos calls; the slice must keep the latest and drop superseded
// results so removed projects don't reappear until restart (#7020).
describe('repos slice stale-fetch race (#7020)', () => {
  it('drops a stale repos fetch that resolves after a newer one', async () => {
    const store = createTestStore()
    let resolveStale!: (repos: Repo[]) => void
    const stalePromise = new Promise<Repo[]>((resolve) => {
      resolveStale = resolve
    })
    // Why: mirrors the delete-project-group burst — the first fetch reads
    // pre-removal state (both repos) but resolves LAST; the second reads
    // post-removal state (remoteRepo gone) and resolves first.
    reposList.mockReturnValueOnce(stalePromise).mockResolvedValueOnce([localRepo])

    const stale = store.getState().fetchRepos()
    const fresh = store.getState().fetchRepos()
    await fresh
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo'])

    resolveStale([localRepo, remoteRepo])
    await stale
    // The superseded fetch must not resurrect the removed repo.
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo'])
  })

  it('a superseding fetch that later rejects still blocks the older stale fetch', async () => {
    const store = createTestStore()
    let resolveStale!: (repos: Repo[]) => void
    const stalePromise = new Promise<Repo[]>((resolve) => {
      resolveStale = resolve
    })
    // The stale fetch reads pre-removal state and resolves LAST; the superseding
    // fetch reads post-removal state but REJECTS. Because the generation is
    // claimed synchronously before the await, the failed fetch still supersedes
    // the stale one, which must be dropped rather than resurrect remoteRepo.
    reposList.mockReturnValueOnce(stalePromise).mockRejectedValueOnce(new Error('boom'))

    const stale = store.getState().fetchRepos()
    await store.getState().fetchRepos()

    resolveStale([localRepo, remoteRepo])
    await stale
    expect(store.getState().repos).toEqual([])
  })
})
