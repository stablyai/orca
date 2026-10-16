import { expect, it, vi } from 'vitest'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('../../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  assertRuntimeEnvironmentCapability: vi.fn(),
  getActiveRuntimeTarget: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
import { createProjectHostSetupActions } from './project-host-setup-actions'
it('projects a central runtime private SSH setup into central ownership in merged renderer state', async () => {
  const state = { repos: [], projects: [], projectHostSetups: [] }
  const raw = {
    project: {
      id: 'project',
      displayName: 'test',
      badgeColor: '#000',
      sourceRepoIds: ['repo'],
      createdAt: 1,
      updatedAt: 1
    },
    repo: {
      id: 'repo',
      path: '/workspace/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 1,
      connectionId: 'runtime-ssh-worker',
      executionHostId: 'ssh:runtime-ssh-worker'
    },
    setup: {
      id: 'setup',
      projectId: 'project',
      hostId: 'ssh:runtime-ssh-worker',
      repoId: 'repo',
      path: '/workspace/repo',
      displayName: 'repo',
      setupState: 'ready',
      setupMethod: 'imported-existing-folder',
      createdAt: 1,
      updatedAt: 1
    }
  }
  rpc.mockResolvedValue({ result: raw })
  const actions = createProjectHostSetupActions(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the isolated fixture supplies the methods exercised by this ownership test.
    ((change: unknown) =>
      Object.assign(state, typeof change === 'function' ? change(state) : change)) as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the isolated fixture supplies the methods exercised by this ownership test.
    (() => state) as never
  )
  const result = await actions.setupProjectExistingFolder({
    projectId: 'project',
    hostId: 'ssh:runtime-ssh-worker',
    runtimeOwnerEnvironmentId: 'central',
    path: '/workspace/repo',
    setupMethod: 'imported-existing-folder'
  })
  expect(rpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'central' },
    'projectHostSetup.setupExistingFolder',
    expect.objectContaining({ hostId: 'ssh:runtime-ssh-worker' }),
    { timeoutMs: 15000 }
  )
  expect(result).toMatchObject({
    repo: { executionHostId: 'runtime:central' },
    setup: {
      hostId: 'runtime:central',
      runtimeOwnerEnvironmentId: 'central',
      connectionId: null,
      executionHostId: 'ssh:runtime-ssh-worker'
    }
  })
  expect(state.repos).toEqual([result!.repo])
  expect(state.projectHostSetups).toEqual([result!.setup])
})
