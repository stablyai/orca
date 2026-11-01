import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { createTestStore } from './store-test-helpers'
import {
  installReposRuntimeRoutingHarness,
  localRepo,
  reposAdd
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
  it('appends the same bare ID when add returns a different host identity', async () => {
    reposAdd.mockResolvedValue({ repo: localRepo, selectedPath: '/canonical/linked' })
    const runtimeSibling: Repo = {
      ...localRepo,
      path: '/runtime/local-repo',
      executionHostId: 'runtime:env-1'
    }
    const store = createTestStore()
    store.setState({ repos: [runtimeSibling] })

    const onResolvedSelectedPath = vi.fn()
    await store.getState().addRepoPath(localRepo.path, 'git', { onResolvedSelectedPath })
    expect(onResolvedSelectedPath).toHaveBeenCalledExactlyOnceWith('/canonical/linked')

    expect(store.getState().repos).toEqual([
      runtimeSibling,
      { ...localRepo, executionHostId: 'local' }
    ])
  })
})
