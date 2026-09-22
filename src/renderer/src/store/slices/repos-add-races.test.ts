import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { createTestStore } from './store-test-helpers'
import {
  installReposRuntimeRoutingHarness,
  localRepo,
  reposAdd,
  reposList
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

    const pendingCatalog = store.getState().fetchRepos()
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
    await store.getState().fetchRepos()
    resolveAdd({ repo: localRepo })
    await pendingAdd

    expect(store.getState().repos).toEqual([{ ...localRepo, executionHostId: 'local' }])
  })
})
