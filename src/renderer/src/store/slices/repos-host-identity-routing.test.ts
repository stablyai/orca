import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree } from './store-test-helpers'
import type { Project, ProjectHostSetup, Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const localDuplicate: Repo = {
  id: 'same-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local'
}

const remoteDuplicate: Repo = {
  id: 'same-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2,
  executionHostId: 'runtime:env-1'
}

const reposRemove = vi.fn()
const reposUpdate = vi.fn()
const reposReorder = vi.fn()
const ptyKill = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

function projectHostSetup(overrides: Pick<ProjectHostSetup, 'id' | 'hostId'>): ProjectHostSetup {
  return {
    projectId: 'repo:same-repo',
    repoId: 'same-repo',
    path: '/same-repo',
    displayName: 'Same Repo',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposRemove.mockReset()
  reposUpdate.mockReset()
  reposReorder.mockReset()
  ptyKill.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: {
        remove: reposRemove,
        update: reposUpdate,
        reorder: reposReorder
      },
      pty: { kill: ptyKill },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice host identity routing', () => {
  it('updates only the focused host row when repo ids are duplicated across hosts', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-duplicate-update',
      ok: true,
      result: { repo: { ...remoteDuplicate, displayName: 'Remote Renamed' } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [localDuplicate, remoteDuplicate]
    })

    await store.getState().updateRepo('same-repo', { displayName: 'Remote Renamed' })

    expect(store.getState().repos).toEqual([
      localDuplicate,
      { ...remoteDuplicate, displayName: 'Remote Renamed' }
    ])
    expect(reposUpdate).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.update',
      params: { repo: 'same-repo', updates: { displayName: 'Remote Renamed' } },
      timeoutMs: 15_000
    })
  })

  it('removes only the focused host row and worktrees for duplicate repo ids', async () => {
    const localWorktree = makeWorktree({
      id: 'same-repo::/local/wt',
      repoId: 'same-repo'
    })
    const remoteWorktree = makeWorktree({
      id: 'same-repo::/remote/wt',
      repoId: 'same-repo',
      hostId: 'runtime:env-1'
    })
    const store = createTestStore()
    store.setState({
      repos: [localDuplicate, remoteDuplicate],
      projects: [
        {
          id: 'repo:same-repo',
          displayName: 'Same Repo',
          badgeColor: '#000',
          sourceRepoIds: ['same-repo'],
          createdAt: 1,
          updatedAt: 1
        } satisfies Project
      ],
      projectHostSetups: [
        projectHostSetup({ id: 'local-setup', hostId: 'local' }),
        projectHostSetup({ id: 'remote-setup', hostId: 'runtime:env-1' })
      ],
      worktreesByRepo: { 'same-repo': [localWorktree, remoteWorktree] },
      tabsByWorktree: {
        [localWorktree.id]: [{ id: 'local-tab', worktreeId: localWorktree.id }] as never,
        [remoteWorktree.id]: [{ id: 'remote-tab', worktreeId: remoteWorktree.id }] as never
      },
      ptyIdsByTabId: {
        'local-tab': ['local-pty'],
        'remote-tab': ['remote-pty']
      }
    })

    await store.getState().removeProject('same-repo')

    expect(store.getState().repos).toEqual([remoteDuplicate])
    expect(store.getState().worktreesByRepo['same-repo']).toEqual([remoteWorktree])
    expect(store.getState().tabsByWorktree[localWorktree.id]).toBeUndefined()
    expect(store.getState().tabsByWorktree[remoteWorktree.id]).toEqual([
      { id: 'remote-tab', worktreeId: remoteWorktree.id }
    ])
    expect(store.getState().projectHostSetups).toEqual([
      expect.objectContaining({ hostId: 'runtime:env-1', repoId: 'same-repo' })
    ])
    expect(store.getState().projects).toEqual([
      expect.objectContaining({ id: 'repo:same-repo', sourceRepoIds: ['same-repo'] })
    ])
    expect(reposRemove).toHaveBeenCalledWith({ repoId: 'same-repo' })
    expect(ptyKill).toHaveBeenCalledWith('local-pty')
    expect(ptyKill).not.toHaveBeenCalledWith('remote-pty')
  })

  it('removes a runtime duplicate without purging legacy local worktrees', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-duplicate-remove',
      ok: true,
      result: { status: 'removed' },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const localWorktree = makeWorktree({
      id: 'same-repo::/local/wt',
      repoId: 'same-repo'
    })
    const remoteWorktree = makeWorktree({
      id: 'same-repo::/remote/wt',
      repoId: 'same-repo',
      hostId: 'runtime:env-1'
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [localDuplicate, remoteDuplicate],
      worktreesByRepo: { 'same-repo': [localWorktree, remoteWorktree] },
      tabsByWorktree: {
        [localWorktree.id]: [{ id: 'local-tab', worktreeId: localWorktree.id }] as never,
        [remoteWorktree.id]: [{ id: 'remote-tab', worktreeId: remoteWorktree.id }] as never
      },
      ptyIdsByTabId: {
        'local-tab': ['local-pty'],
        'remote-tab': ['remote-pty']
      }
    })

    await store.getState().removeProject('same-repo')

    expect(store.getState().repos).toEqual([localDuplicate])
    expect(store.getState().worktreesByRepo['same-repo']).toEqual([localWorktree])
    expect(store.getState().tabsByWorktree[localWorktree.id]).toEqual([
      { id: 'local-tab', worktreeId: localWorktree.id }
    ])
    expect(store.getState().tabsByWorktree[remoteWorktree.id]).toBeUndefined()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.rm',
      params: { repo: 'same-repo' },
      timeoutMs: 15_000
    })
    expect(reposRemove).not.toHaveBeenCalled()
    expect(ptyKill).toHaveBeenCalledWith('remote-pty')
    expect(ptyKill).not.toHaveBeenCalledWith('local-pty')
  })

  it('reorders duplicate repo ids once per owning host', async () => {
    reposReorder.mockResolvedValue({ status: 'applied' })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-duplicate-reorder',
      ok: true,
      result: { status: 'applied' },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ repos: [localDuplicate, remoteDuplicate] })

    await store.getState().reorderRepos(['same-repo', 'same-repo'])

    expect(store.getState().repos).toEqual([localDuplicate, remoteDuplicate])
    expect(reposReorder).toHaveBeenCalledWith({ orderedIds: ['same-repo'] })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.reorder',
      params: { orderedIds: ['same-repo'] },
      timeoutMs: 15_000
    })
  })
})
