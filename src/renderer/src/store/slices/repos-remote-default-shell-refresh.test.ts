import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Project, ProjectHostSetup } from '../../../../shared/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
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

describe('remote project refresh and the client-local defaultShell axis', () => {
  const sharedProjectId = 'github:acme/app'

  function remoteSetup(hostId: ExecutionHostId): ProjectHostSetup {
    return {
      id: 'remote-setup',
      projectId: sharedProjectId,
      hostId,
      repoId: 'remote-repo',
      path: '/srv/app',
      displayName: 'Remote',
      setupState: 'ready',
      setupMethod: 'imported-existing-folder',
      createdAt: 1,
      updatedAt: 1
    }
  }

  function mockRuntimeCatalog(): void {
    // Remote project.list carries its own defaultShell ('cmd'); it must never
    // land on the client-local project record during a remote refresh.
    const remoteProject: Project = {
      id: sharedProjectId,
      displayName: 'App',
      badgeColor: '#111',
      sourceRepoIds: ['remote-repo'],
      defaultShell: 'cmd',
      createdAt: 2,
      updatedAt: 2
    }
    runtimeEnvironmentCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'repo.list') {
        return {
          id: 'rpc-repo-list',
          ok: true,
          result: { repos: [remoteRepo] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'project.list') {
        return {
          id: 'rpc-project-list',
          ok: true,
          result: { projects: [remoteProject] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'projectHostSetup.list') {
        return {
          id: 'rpc-setup-list',
          ok: true,
          result: { setups: [remoteSetup('local')] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return { id: 'rpc-other', ok: true, result: {}, _meta: { runtimeId: 'runtime-remote' } }
    })
  }

  function seedStoreWithSharedProject(
    defaultShell?: Project['defaultShell']
  ): ReturnType<typeof createTestStore> {
    const previousProject: Project = {
      id: sharedProjectId,
      displayName: 'App',
      badgeColor: '#000',
      sourceRepoIds: ['remote-repo'],
      ...(defaultShell ? { defaultShell } : {}),
      createdAt: 1,
      updatedAt: 1
    }
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projects: [previousProject],
      projectHostSetups: [{ ...remoteSetup('runtime:env-1'), executionHostId: 'runtime:env-1' }]
    })
    return store
  }

  it('drops the remote defaultShell when the client-local project has no override', async () => {
    mockRuntimeCatalog()
    const store = seedStoreWithSharedProject()

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    const project = store.getState().projects.find((entry) => entry.id === sharedProjectId)
    expect(project).toBeDefined()
    expect(project?.defaultShell).toBeUndefined()
  })

  it('preserves a genuine client-local defaultShell override across a remote refresh', async () => {
    mockRuntimeCatalog()
    const store = seedStoreWithSharedProject('powershell')

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    const project = store.getState().projects.find((entry) => entry.id === sharedProjectId)
    expect(project?.defaultShell).toBe('powershell')
  })
})
