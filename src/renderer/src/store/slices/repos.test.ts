import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTestStore, makeWorktree } from './store-test-helpers'
import type { Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2
}

const reposList = vi.fn()
const reposAdd = vi.fn()
const reposPickFolder = vi.fn()
const reposRemove = vi.fn()
const reposUpdate = vi.fn()
const reposReorder = vi.fn()
const ptyKill = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset()
  reposAdd.mockReset()
  reposPickFolder.mockReset()
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
        list: reposList,
        add: reposAdd,
        pickFolder: reposPickFolder,
        remove: reposRemove,
        update: reposUpdate,
        reorder: reposReorder
      },
      pty: { kill: ptyKill },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice runtime routing', () => {
  it('fetches repos from local IPC when no remote environment is active', async () => {
    reposList.mockResolvedValue([localRepo])
    const store = createTestStore()

    await store.getState().fetchRepos()

    expect(store.getState().repos).toEqual([localRepo])
    expect(reposList).toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('fetches repos from the active remote runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { repos: [remoteRepo] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      activeRepoId: 'stale-repo',
      filterRepoIds: ['remote-repo', 'stale-repo']
    })

    await store.getState().fetchRepos()

    expect(store.getState().repos).toEqual([remoteRepo])
    expect(store.getState().activeRepoId).toBeNull()
    expect(store.getState().filterRepoIds).toEqual(['remote-repo'])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.list',
      params: undefined,
      timeoutMs: 15_000
    })
    expect(reposList).not.toHaveBeenCalled()
  })

  it('updates repos through the active remote runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-2',
      ok: true,
      result: { repo: { ...remoteRepo, displayName: 'Renamed' } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [remoteRepo]
    })

    await store.getState().updateRepo(remoteRepo.id, { displayName: 'Renamed' })

    expect(store.getState().repos[0]?.displayName).toBe('Renamed')
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.update',
      params: { repo: remoteRepo.id, updates: { displayName: 'Renamed' } },
      timeoutMs: 15_000
    })
    expect(reposUpdate).not.toHaveBeenCalled()
  })

  it('adds explicit server paths through the active remote runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-add',
      ok: true,
      result: { repo: remoteRepo },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never
    })

    await expect(store.getState().addRepoPath('/srv/project', 'folder')).resolves.toEqual(
      remoteRepo
    )

    expect(store.getState().repos).toEqual([remoteRepo])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.add',
      params: { path: '/srv/project', kind: 'folder' },
      timeoutMs: 15_000
    })
    expect(reposAdd).not.toHaveBeenCalled()
    expect(reposPickFolder).not.toHaveBeenCalled()
  })

  it('does not open the client folder picker when a remote runtime environment is active', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never
    })

    await expect(store.getState().addRepo()).resolves.toBeNull()

    expect(reposPickFolder).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('removes repos through the active remote runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-3',
      ok: true,
      result: { removed: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [remoteRepo],
      activeRepoId: remoteRepo.id
    })

    await store.getState().removeRepo(remoteRepo.id)

    expect(store.getState().repos).toEqual([])
    expect(store.getState().activeRepoId).toBeNull()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.rm',
      params: { repo: remoteRepo.id },
      timeoutMs: 15_000
    })
    expect(reposRemove).not.toHaveBeenCalled()
  })

  it('stops remote runtime terminals instead of killing remote ids through local pty IPC', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-remote',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    const worktreeId = `${remoteRepo.id}::/remote/wt`
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [remoteRepo],
      worktreesByRepo: {
        [remoteRepo.id]: [makeWorktree({ id: worktreeId, repoId: remoteRepo.id })]
      },
      tabsByWorktree: {
        [worktreeId]: [{ id: 'tab-1', worktreeId } as never]
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:term-1', 'pty-local-stale']
      }
    })

    await store.getState().removeRepo(remoteRepo.id)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.stop',
      params: { worktree: worktreeId },
      timeoutMs: 15_000
    })
    expect(ptyKill).toHaveBeenCalledWith('pty-local-stale')
    expect(ptyKill).not.toHaveBeenCalledWith('remote:term-1')
  })

  it('reorders repos through the active remote runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-4',
      ok: true,
      result: { status: 'applied' },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [localRepo, remoteRepo]
    })

    await store.getState().reorderRepos([remoteRepo.id, localRepo.id])

    expect(store.getState().repos.map((repo) => repo.id)).toEqual([remoteRepo.id, localRepo.id])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.reorder',
      params: { orderedIds: [remoteRepo.id, localRepo.id] },
      timeoutMs: 15_000
    })
    expect(reposReorder).not.toHaveBeenCalled()
  })
})
