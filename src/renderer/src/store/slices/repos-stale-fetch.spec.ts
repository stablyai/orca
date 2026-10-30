import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTestStore, makeLayout, makeTab } from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

export function registerReposStaleFetchTests(): void {
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
  const promotionWorktreeId = 'local-repo::/local'
  const promotionTabId = 'restored-tab'
  const promotionPtyId = 'original-daemon-pty'

  function makePromotionSession(): WorkspaceSessionState {
    return {
      ...getDefaultWorkspaceSession(),
      activeRepoId: localRepo.id,
      activeWorktreeId: promotionWorktreeId,
      activeTabId: promotionTabId,
      activeWorktreeIdsOnShutdown: [promotionWorktreeId],
      tabsByWorktree: {
        [promotionWorktreeId]: [
          makeTab({
            id: promotionTabId,
            worktreeId: promotionWorktreeId,
            ptyId: promotionPtyId
          })
        ]
      },
      terminalLayoutsByTabId: {
        [promotionTabId]: {
          ...makeLayout(),
          ptyIdsByLeafId: { 'pane:1': promotionPtyId }
        }
      }
    }
  }

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

    it('waits for the superseding catalog fetch before startup hydration', async () => {
      let resolveStartup!: (repos: Repo[]) => void
      let resolveRefresh!: (repos: Repo[]) => void
      const startupRepos = new Promise<Repo[]>((resolve) => {
        resolveStartup = resolve
      })
      const refreshedRepos = new Promise<Repo[]>((resolve) => {
        resolveRefresh = resolve
      })
      reposList.mockReturnValueOnce(startupRepos).mockReturnValueOnce(refreshedRepos)
      const store = createTestStore()

      const startup = store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
      const refresh = store.getState().fetchRepos(catalogOwner(store))
      resolveStartup([localRepo])
      await startup

      let settled = false
      const settlement = store
        .getState()
        .awaitLocalRepoCatalogSettlement()
        .then(() => {
          settled = true
        })
      await Promise.resolve()
      expect(settled).toBe(false)

      resolveRefresh([localRepo])
      await Promise.all([refresh, settlement])
      expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo'])

      store.getState().hydrateWorkspaceSession(makePromotionSession())

      expect(store.getState().activeWorktreeId).toBe(promotionWorktreeId)
      expect(store.getState().pendingReconnectPtyIdByTabId).toEqual({
        [promotionTabId]: promotionPtyId
      })
      expect(store.getState().terminalLayoutsByTabId[promotionTabId]?.ptyIdsByLeafId).toEqual({
        'pane:1': promotionPtyId
      })
    })

    it('waits for a refresh started after initial settlement before startup hydration', async () => {
      let resolveRefresh!: (repos: Repo[]) => void
      const refreshedRepos = new Promise<Repo[]>((resolve) => {
        resolveRefresh = resolve
      })
      reposList.mockResolvedValueOnce([localRepo]).mockReturnValueOnce(refreshedRepos)
      const store = createTestStore()

      await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
      await store.getState().awaitLocalRepoCatalogSettlement()
      const refresh = store.getState().fetchRepos(catalogOwner(store))
      let hydrated = false
      const hydration = (async () => {
        await store.getState().awaitLocalRepoCatalogSettlement()
        store.getState().hydrateWorkspaceSession(makePromotionSession())
        hydrated = true
      })()

      await Promise.resolve()
      expect(hydrated).toBe(false)

      resolveRefresh([localRepo])
      await Promise.all([refresh, hydration])
      expect(store.getState().activeWorktreeId).toBe(promotionWorktreeId)
      expect(store.getState().pendingReconnectPtyIdByTabId[promotionTabId]).toBe(promotionPtyId)
    })

    it('rejects startup settlement when the superseding local catalog fails', async () => {
      let resolveStartup!: (repos: Repo[]) => void
      const startupRepos = new Promise<Repo[]>((resolve) => {
        resolveStartup = resolve
      })
      reposList.mockReturnValueOnce(startupRepos).mockRejectedValueOnce(new Error('catalog failed'))
      const store = createTestStore()

      const startup = store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
      const refresh = store.getState().fetchRepos(catalogOwner(store))
      resolveStartup([localRepo])
      await Promise.all([startup, refresh])

      const hydration = async (): Promise<void> => {
        await store.getState().awaitLocalRepoCatalogSettlement()
        store.getState().hydrateWorkspaceSession(makePromotionSession())
      }
      await expect(hydration()).rejects.toThrow('catalog failed')
      expect(store.getState().tabsByWorktree).toEqual({})
      expect(store.getState().terminalLayoutsByTabId).toEqual({})
      expect(store.getState().pendingReconnectPtyIdByTabId).toEqual({})
    })
  })

  // The catalog these tests read is the one the focused host would have shown.
  function catalogOwner(store: {
    getState: () => { settings: { activeRuntimeEnvironmentId?: string | null } | null }
  }): { runtimeEnvironmentId: string | null } {
    return { runtimeEnvironmentId: store.getState().settings?.activeRuntimeEnvironmentId ?? null }
  }
}
