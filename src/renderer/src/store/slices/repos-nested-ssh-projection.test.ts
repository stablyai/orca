import { expect, it, vi } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../../shared/types'
import { createTestStore } from './store-test-helpers'
import {
  installReposRuntimeRoutingHarness,
  remoteRepo,
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

it('preserves distinct SSH execution setups behind the same runtime owner', async () => {
  const project: Project = {
    id: 'project-1',
    displayName: 'Project',
    badgeColor: '#000',
    sourceRepoIds: [remoteRepo.id],
    createdAt: 1,
    updatedAt: 1
  }
  const setup = (id: string, executionHostId: `ssh:${string}`): ProjectHostSetup => ({
    id,
    projectId: project.id,
    hostId: executionHostId,
    executionHostId,
    repoId: remoteRepo.id,
    path: remoteRepo.path,
    displayName: remoteRepo.displayName,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  })
  runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
    if (method === 'repo.list') {
      return Promise.resolve({
        id: 'repo-list',
        ok: true,
        result: { repos: [{ ...remoteRepo, connectionId: 'direct' }] },
        _meta: { runtimeId: 'runtime-remote' }
      })
    }
    if (method === 'project.list') {
      return Promise.resolve({
        id: 'project-list',
        ok: true,
        result: { projects: [project] },
        _meta: { runtimeId: 'runtime-remote' }
      })
    }
    if (method === 'projectHostSetup.list') {
      return Promise.resolve({
        id: 'setup-list',
        ok: true,
        result: {
          setups: [setup('direct-setup', 'ssh:direct'), setup('jump-setup', 'ssh:jump')]
        },
        _meta: { runtimeId: 'runtime-remote' }
      })
    }
    throw new Error(`Unexpected method ${method}`)
  })
  const store = createTestStore()
  store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

  await store.getState().fetchRepos()

  expect(store.getState().projectHostSetups).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'direct-setup',
        hostId: 'runtime:env-1',
        executionHostId: 'ssh:direct',
        runtimeOwnerEnvironmentId: 'env-1'
      }),
      expect.objectContaining({
        id: 'jump-setup',
        hostId: 'runtime:env-1',
        executionHostId: 'ssh:jump',
        runtimeOwnerEnvironmentId: 'env-1'
      })
    ])
  )
})
