import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import {
  installReposRuntimeRoutingHarness,
  localRepo,
  remoteRepo,
  reposAdd,
  runtimeEnvironmentCall,
  workspaceTrustResolveIntake
} from './repos-runtime-routing-fixture'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

installReposRuntimeRoutingHarness()

// Guards Req: Intake Resolves a Trust Outcome Before Completing / Both Intake Choke Points
// Share the Predicate — a fully local `repos:add` must resolve trust; a runtime-hosted add has
// no local filesystem root to gate.
describe('repo slice — workspace trust wiring on repos:add', () => {
  it('resolves workspace trust for a fully local add', async () => {
    reposAdd.mockResolvedValue({ repo: localRepo })
    const store = createTestStore()

    await store.getState().addRepoPath('/local')

    expect(workspaceTrustResolveIntake).toHaveBeenCalledWith({
      target: { kind: 'repo', repoId: localRepo.id }
    })
  })

  it('does not resolve workspace trust for a runtime-hosted add', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-add',
      ok: true,
      result: { repo: remoteRepo },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().addRepoPath('/srv/project', 'folder')

    expect(workspaceTrustResolveIntake).not.toHaveBeenCalled()
  })
})
