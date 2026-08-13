import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectHostSetup, Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore, makeWorktree } from './store-test-helpers'

const projectsCreateHostSetup = vi.fn()
const projectsUpdateHostSetup = vi.fn()
const projectsDeleteHostSetup = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const project: Project = {
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#000',
  sourceRepoIds: ['local-repo'],
  createdAt: 1,
  updatedAt: 1
}

const runtimeRepo: Repo = {
  id: 'runtime-repo',
  path: '/srv/project',
  displayName: 'Project',
  badgeColor: '#111',
  addedAt: 1,
  executionHostId: 'runtime:env-1'
}

const runtimeSetup: ProjectHostSetup = {
  id: 'setup-gpu',
  projectId: project.id,
  hostId: 'runtime:env-1',
  repoId: '',
  path: '/srv/project',
  displayName: 'GPU VM',
  setupState: 'ready',
  setupMethod: 'provisioned',
  createdAt: 1,
  updatedAt: 1
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  projectsCreateHostSetup.mockReset()
  projectsUpdateHostSetup.mockReset()
  projectsDeleteHostSetup.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: {
        list: vi.fn()
      },
      projects: {
        createHostSetup: projectsCreateHostSetup,
        updateHostSetup: projectsUpdateHostSetup,
        deleteHostSetup: projectsDeleteHostSetup
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice project host setup lifecycle', () => {
  it('creates independent project host setup metadata through local IPC', async () => {
    const setup: ProjectHostSetup = {
      ...runtimeSetup,
      hostId: 'local',
      path: '',
      setupState: 'setting-up'
    }
    projectsCreateHostSetup.mockResolvedValue({ project, setup })
    const store = createTestStore()

    await expect(
      store.getState().createProjectHostSetup({
        projectId: project.id,
        hostId: 'local',
        setupId: setup.id,
        setupState: 'setting-up',
        setupMethod: 'provisioned'
      })
    ).resolves.toEqual({ project, setup })

    expect(store.getState().projects).toEqual([project])
    expect(store.getState().projectHostSetups).toEqual([setup])
    expect(projectsCreateHostSetup).toHaveBeenCalledWith({
      projectId: project.id,
      hostId: 'local',
      setupId: setup.id,
      setupState: 'setting-up',
      setupMethod: 'provisioned'
    })
  })

  it('updates runtime-owned project host setups through their owning runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-update-setup',
      ok: true,
      result: {
        result: {
          project,
          setup: { ...runtimeSetup, displayName: 'GPU VM renamed' }
        }
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      projectHostSetups: [runtimeSetup],
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    await expect(
      store.getState().updateProjectHostSetup({
        setupId: runtimeSetup.id,
        updates: { displayName: 'GPU VM renamed' }
      })
    ).resolves.toEqual({
      project,
      setup: {
        ...runtimeSetup,
        displayName: 'GPU VM renamed',
        executionHostId: 'runtime:env-1',
        runtimeOwnerEnvironmentId: 'env-1',
        connectionId: null
      },
      repo: undefined
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectHostSetup.update',
      params: {
        setupId: runtimeSetup.id,
        updates: { displayName: 'GPU VM renamed' }
      },
      timeoutMs: 15_000
    })
  })

  it('deletes runtime-owned project host setups through their owning runtime', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-setup',
      ok: true,
      result: { result: { project, setup: runtimeSetup } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      projects: [project],
      projectHostSetups: [runtimeSetup],
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    await expect(
      store.getState().deleteProjectHostSetup({ setupId: runtimeSetup.id })
    ).resolves.toEqual({
      project,
      setup: runtimeSetup,
      repo: undefined
    })

    expect(store.getState().projects).toEqual([project])
    expect(store.getState().projectHostSetups).toEqual([])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectHostSetup.delete',
      params: { setupId: runtimeSetup.id },
      timeoutMs: 15_000
    })
  })

  it('purges worktree state when deleting an imported runtime setup', async () => {
    const attachedSetup = { ...runtimeSetup, repoId: runtimeRepo.id }
    const worktree = makeWorktree({
      id: `${runtimeRepo.id}::${runtimeRepo.path}`,
      repoId: runtimeRepo.id,
      path: runtimeRepo.path,
      hostId: 'runtime:env-1'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-imported-setup',
      ok: true,
      result: { result: { project, setup: attachedSetup, repo: runtimeRepo } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      projects: [project],
      projectHostSetups: [attachedSetup],
      repos: [runtimeRepo],
      worktreesByRepo: { [runtimeRepo.id]: [worktree] },
      tabsByWorktree: { [worktree.id]: [] },
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    await store.getState().deleteProjectHostSetup({ setupId: attachedSetup.id })

    expect(store.getState().repos).toEqual([])
    expect(store.getState().worktreesByRepo[runtimeRepo.id]).toBeUndefined()
    expect(store.getState().tabsByWorktree[worktree.id]).toBeUndefined()
  })

  it('preserves worktree state for a same-id checkout retained on another host', async () => {
    const attachedSetup = { ...runtimeSetup, repoId: runtimeRepo.id }
    const worktreeId = `${runtimeRepo.id}::${runtimeRepo.path}`
    const runtimeWorktree = makeWorktree({
      id: worktreeId,
      repoId: runtimeRepo.id,
      path: runtimeRepo.path,
      hostId: 'runtime:env-1'
    })
    const localWorktree = { ...runtimeWorktree, hostId: 'local' as const }
    const localRepo = { ...runtimeRepo, executionHostId: 'local' as const }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-host-collision',
      ok: true,
      result: { result: { project, setup: attachedSetup, repo: runtimeRepo } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      projects: [project],
      projectHostSetups: [attachedSetup],
      repos: [runtimeRepo, localRepo],
      worktreesByRepo: { [runtimeRepo.id]: [runtimeWorktree, localWorktree] },
      tabsByWorktree: { [worktreeId]: [] },
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    await store.getState().deleteProjectHostSetup({ setupId: attachedSetup.id })

    expect(store.getState().worktreesByRepo[runtimeRepo.id]).toEqual([localWorktree])
    expect(store.getState().tabsByWorktree[worktreeId]).toEqual([])
  })

  it('returns null for failed setup deletion without mutating imported project state', async () => {
    const attachedSetup = { ...runtimeSetup, repoId: runtimeRepo.id }
    const worktree = makeWorktree({
      id: `${runtimeRepo.id}::${runtimeRepo.path}`,
      repoId: runtimeRepo.id,
      path: runtimeRepo.path,
      hostId: 'runtime:env-1'
    })
    runtimeEnvironmentCall.mockRejectedValue(new Error('runtime unavailable'))
    const store = createTestStore()
    store.setState({
      projects: [project],
      projectHostSetups: [attachedSetup],
      repos: [runtimeRepo],
      worktreesByRepo: { [runtimeRepo.id]: [worktree] },
      tabsByWorktree: { [worktree.id]: [] },
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    await expect(
      store.getState().deleteProjectHostSetup({ setupId: attachedSetup.id })
    ).resolves.toBeNull()

    expect(store.getState().projects).toEqual([project])
    expect(store.getState().projectHostSetups).toEqual([attachedSetup])
    expect(store.getState().repos).toEqual([runtimeRepo])
    expect(store.getState().worktreesByRepo[runtimeRepo.id]).toEqual([worktree])
    expect(store.getState().tabsByWorktree[worktree.id]).toEqual([])
  })

  it('preserves runtime-fetched setup-only states during repo hydration', async () => {
    const pendingSetup: ProjectHostSetup = {
      ...runtimeSetup,
      id: 'setup-pending',
      repoId: '',
      path: '',
      setupState: 'setting-up'
    }
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        return {
          id: 'rpc-repos',
          ok: true,
          result: { repos: [runtimeRepo] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'project.list') {
        return {
          id: 'rpc-projects',
          ok: true,
          result: { projects: [project] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'projectHostSetup.list') {
        return {
          id: 'rpc-setups',
          ok: true,
          result: { setups: [pendingSetup] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      throw new Error(`Unexpected runtime method: ${args.method}`)
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchRepos()

    expect(store.getState().projectHostSetups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'setup-pending',
          hostId: 'runtime:env-1',
          setupState: 'setting-up'
        })
      ])
    )
  })
})
