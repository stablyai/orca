import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'
import type { Repo } from '../../../../shared/repository/repo-types'
import { callRuntimeRpc } from '../../runtime/rpc/calls/runtime-rpc-call'
vi.mock('../../runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))
const remoteRepo: Repo = {
  id: 'r1',
  displayName: 'repo',
  path: '/repo',
  badgeColor: '#000',
  addedAt: 0
}
// Why stamped: an unstamped row is this app's own and routes to local IPC.
const serverRepo: Repo = { ...remoteRepo, executionHostId: 'runtime:env-1' }
const pinnedRepo: Repo = { ...serverRepo, worktreeBaseRef: 'origin/dev' }

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
    vi.mocked(callRuntimeRpc).mockResolvedValue({ repo: serverRepo })
    const store = makeStore()

    const saved = await store.getState().updateRepo(remoteRepo.id, { worktreeBaseRef: undefined })

    expect(saved).toBe(true)
    expect(store.getState().repos[0]?.worktreeBaseRef).toBeUndefined()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      expect.anything(),
      'repo.update',
      { repo: remoteRepo.id, updates: { worktreeBaseRef: null } },
      expect.anything()
    )
  })

  it('reports failure when a host that predates the sentinel echoes the pin back', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue({ repo: pinnedRepo })
    const store = makeStore()

    const saved = await store.getState().updateRepo(remoteRepo.id, { worktreeBaseRef: undefined })

    expect(saved).toBe(false)
    expect(store.getState().repos[0]?.worktreeBaseRef).toBe('origin/dev')
  })
})
