import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'
import type { Repo } from '../../../../shared/repo-types'

import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'

afterEach(() => vi.restoreAllMocks())

describe('repos-stale-fetch', () => {
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
    // Missing projects API forces compatibility fallback to repos; only repos.list is exercised.
    vi.stubGlobal('window', {
      api: {
        repos: {
          list: reposList,
          removeForHost: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
  })

  // Overlapping repos:changed fetches must drop superseded results or removed projects reappear (#7020).
  describe('repos slice stale-fetch race (#7020)', () => {
    it('drops a stale repos fetch that resolves after a newer one', async () => {
      const store = createTestStore()
      let resolveStale!: (repos: Repo[]) => void
      const stalePromise = new Promise<Repo[]>((resolve) => {
        resolveStale = resolve
      })
      // Simulate group deletion: pre-removal fetch resolves after post-removal fetch.
      reposList.mockReturnValueOnce(stalePromise).mockResolvedValueOnce([localRepo])

      const stale = store.getState().fetchRepos(catalogOwner(store))
      const fresh = store.getState().fetchRepos(catalogOwner(store))
      await fresh
      expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo'])

      resolveStale([localRepo, remoteRepo])
      await stale
      expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo'])
    })

    it('a superseding fetch that later rejects still blocks the older stale fetch', async () => {
      const store = createTestStore()
      let resolveStale!: (repos: Repo[]) => void
      const stalePromise = new Promise<Repo[]>((resolve) => {
        resolveStale = resolve
      })
      // Even a rejected newer fetch claims the generation synchronously, so late pre-removal results must be dropped.
      reposList.mockReturnValueOnce(stalePromise).mockRejectedValueOnce(new Error('boom'))

      const stale = store.getState().fetchRepos(catalogOwner(store))
      await store.getState().fetchRepos(catalogOwner(store))

      resolveStale([localRepo, remoteRepo])
      await stale
      expect(store.getState().repos).toEqual([])
    })
  })

  // The catalog these tests read is the one the focused host would have shown.
  function catalogOwner(store: {
    getState: () => { settings: { activeRuntimeEnvironmentId?: string | null } | null }
  }): { runtimeEnvironmentId: string | null } {
    return { runtimeEnvironmentId: store.getState().settings?.activeRuntimeEnvironmentId ?? null }
  }
})
