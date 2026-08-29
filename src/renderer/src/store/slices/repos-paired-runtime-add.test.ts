import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import {
  installReposRuntimeRoutingHarness,
  remoteRepo,
  reposAdd,
  reposPickFolder,
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

describe('paired runtime repo add routing', () => {
  it('submits the selected host path to repo.add without native filesystem calls', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-paired-add',
      ok: true,
      result: { repo: remoteRepo },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()

    await store.getState().addRepoPath('/srv/paired-project', 'folder', {
      runtimeEnvironmentId: 'paired-host'
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'paired-host',
      method: 'repo.add',
      params: { path: '/srv/paired-project', kind: 'folder' },
      timeoutMs: 15_000
    })
    expect(reposAdd).not.toHaveBeenCalled()
    expect(reposPickFolder).not.toHaveBeenCalled()
  })
})
