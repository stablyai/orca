import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import {
  installReposRuntimeRoutingHarness,
  remoteRepo,
  reposUpdate,
  runtimeEnvironmentCall
} from './repos-runtime-routing-fixture'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

installReposRuntimeRoutingHarness()

const pinnedRepo = { ...remoteRepo, worktreeBaseRef: 'origin/dev' }

function makeStore() {
  const store = createTestStore()
  store.setState({
    settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
    repos: [pinnedRepo]
  })
  return store
}

describe('clearing the project default on a remote runtime', () => {
  it('sends null so the JSON transport carries the clear', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-clear',
      ok: true,
      result: { repo: remoteRepo },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = makeStore()

    const saved = await store.getState().updateRepo(remoteRepo.id, { worktreeBaseRef: undefined })

    expect(saved).toBe(true)
    expect(store.getState().repos[0]?.worktreeBaseRef).toBeUndefined()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'repo.update',
        params: { repo: remoteRepo.id, updates: { worktreeBaseRef: null } }
      })
    )
    expect(reposUpdate).not.toHaveBeenCalled()
  })

  it('reports failure when a host that predates the sentinel echoes the pin back', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-clear',
      ok: true,
      result: { repo: pinnedRepo },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = makeStore()

    const saved = await store.getState().updateRepo(remoteRepo.id, { worktreeBaseRef: undefined })

    expect(saved).toBe(false)
    expect(store.getState().repos[0]?.worktreeBaseRef).toBe('origin/dev')
  })
})
