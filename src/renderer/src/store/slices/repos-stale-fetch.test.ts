import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTestStore, makeLayout, makeTab } from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
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
  // Only repos.list is exercised here — the missing projects API makes
  // fetchProjectHostSetupCompatibility fall back to deriving from repos.
  vi.stubGlobal('window', {
    api: {
      repos: {
        list: reposList,
        remove: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
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

  it('reapplies an in-flight catalog after the repo is removed', async () => {
    const { promise: catalog, resolve: resolveCatalog } = Promise.withResolvers<Repo[]>()
    reposList.mockReturnValueOnce(catalog)
    const store = createTestStore()
    store.setState({ repos: [localRepo] })

    const pending = store.getState().fetchRepos()
    await store.getState().removeProject(localRepo.id)
    expect(store.getState().repos).toEqual([])

    resolveCatalog([localRepo])
    await pending

    // Current contract: removal does not claim a catalog generation, so the latest fetch can resurrect it.
    expect(store.getState().repos).toEqual([{ ...localRepo, executionHostId: 'local' }])
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
    const refresh = store.getState().fetchRepos()
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
    const refresh = store.getState().fetchRepos()
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
    const refresh = store.getState().fetchRepos()
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
