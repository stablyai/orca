import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { createEnvironmentFromPairingOffer } from '../../../../shared/runtime-environments'
import type { Repo } from '../../../../shared/repo-types'
import { createTestStore } from './store-test-helpers'
import {
  installReposRuntimeRoutingHarness,
  localRepo,
  reposAdd,
  reposList,
  runtimeEnvironmentsList,
  runtimeEnvironmentCall
} from './repos-runtime-routing-fixture'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

installReposRuntimeRoutingHarness()

describe('repo add/catalog races', () => {
  it.each(['\\\\wsl$', '\\\\?\\UNC\\wsl.localhost'])(
    'refreshes and adopts an incomplete owner registration for %s with useful copy',
    async (share) => {
      const environment = createEnvironmentFromPairingOffer({
        id: 'wsl:ubuntu',
        name: 'Ubuntu',
        now: 1,
        offer: {
          v: 2,
          endpoint: 'ws://127.0.0.1:42000',
          deviceToken: 'fixture',
          publicKeyB64: 'fixture'
        }
      })
      runtimeEnvironmentsList.mockResolvedValue([
        {
          ...environment,
          orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
        }
      ])
      Object.assign(window.api.runtimeEnvironments, {
        wslHosts: {},
        getStatusSnapshots: vi.fn(async () => [])
      })
      const incomplete =
        'The project was added on WSL, but its setup could not be completed. Open the project on its WSL host to finish setup.'
      reposAdd.mockRejectedValue(
        new Error(`Error invoking remote method 'repos:add': Error: ${incomplete}`)
      )
      runtimeEnvironmentCall.mockImplementation(async ({ method }) => ({
        id: method,
        ok: true,
        result: method === 'repo.list' ? { repos: [{ ...localRepo, path: '/home/me/App' }] } : {},
        _meta: { runtimeId: 'owner-runtime' }
      }))
      const store = createTestStore()
      store.setState({ settings: createGlobalSettingsFixture({ experimentalWslHosts: true }) })
      const fetch = vi.spyOn(store.getState(), 'fetchRepos')
      await expect(
        store.getState().addRepoPath(`${share}\\Ubuntu\\home\\me\\App`)
      ).resolves.toBeNull()
      expect(runtimeEnvironmentsList).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledWith({ runtimeEnvironmentId: environment.id })
      expect(store.getState().repos).toContainEqual({
        ...localRepo,
        path: '/home/me/App',
        executionHostId: 'runtime:wsl%3Aubuntu'
      })
      expect(toast.error).toHaveBeenCalledWith('Failed to add project', {
        description: incomplete,
        duration: expect.any(Number)
      })
    }
  )

  it('does not append a same-host duplicate returned by add', async () => {
    reposAdd.mockResolvedValue({ repo: localRepo })
    const existing = { ...localRepo, executionHostId: 'local' as const }
    const store = createTestStore()
    store.setState({ repos: [existing] })

    await expect(store.getState().addRepoPath(localRepo.path)).resolves.toEqual(existing)

    expect(store.getState().repos).toEqual([existing])
  })

  it('appends the same bare ID when add returns a different host identity', async () => {
    reposAdd.mockResolvedValue({ repo: localRepo })
    const runtimeSibling: Repo = {
      ...localRepo,
      path: '/runtime/local-repo',
      executionHostId: 'runtime:env-1'
    }
    const store = createTestStore()
    store.setState({ repos: [runtimeSibling] })

    await store.getState().addRepoPath(localRepo.path)

    expect(store.getState().repos).toEqual([
      runtimeSibling,
      { ...localRepo, executionHostId: 'local' }
    ])
  })

  it('lets a catalog resolving after add remove the newly added row', async () => {
    const { promise: catalog, resolve: resolveCatalog } = Promise.withResolvers<Repo[]>()
    reposList.mockReturnValueOnce(catalog)
    reposAdd.mockResolvedValue({ repo: localRepo })
    const store = createTestStore()

    const pendingCatalog = store.getState().fetchRepos(catalogOwner(store))
    await store.getState().addRepoPath(localRepo.path)
    expect(store.getState().repos).toHaveLength(1)

    resolveCatalog([])
    await pendingCatalog

    expect(store.getState().repos).toEqual([])
  })

  it('keeps an add that completes after the catalog applies', async () => {
    const { promise: add, resolve: resolveAdd } = Promise.withResolvers<{ repo: Repo }>()
    reposList.mockResolvedValueOnce([])
    reposAdd.mockReturnValueOnce(add)
    const store = createTestStore()

    const pendingAdd = store.getState().addRepoPath(localRepo.path)
    await store.getState().fetchRepos(catalogOwner(store))
    resolveAdd({ repo: localRepo })
    await pendingAdd

    expect(store.getState().repos).toEqual([{ ...localRepo, executionHostId: 'local' }])
  })
})

// The catalog these tests read is the one the focused host would have shown.
function catalogOwner(store: {
  getState: () => { settings: { activeRuntimeEnvironmentId?: string | null } | null }
}): { runtimeEnvironmentId: string | null } {
  return { runtimeEnvironmentId: store.getState().settings?.activeRuntimeEnvironmentId ?? null }
}
