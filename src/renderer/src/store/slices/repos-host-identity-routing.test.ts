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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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

  it('updates a legacy local duplicate without overwriting an explicit remote sibling', async () => {
    const { executionHostId: _executionHostId, ...legacyLocalDuplicate } = localDuplicate
    reposUpdate.mockResolvedValue(undefined)
    const store = createTestStore()
    store.setState({ repos: [legacyLocalDuplicate as Repo, remoteDuplicate] })

    await store.getState().updateRepo('same-repo', { displayName: 'Local Renamed' })

    expect(store.getState().repos).toEqual([
      { ...legacyLocalDuplicate, displayName: 'Local Renamed' },
      remoteDuplicate
    ])
    expect(reposUpdate).toHaveBeenCalledWith({
      repoId: 'same-repo',
      updates: { displayName: 'Local Renamed' }
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'repo.update' })
    )
  })

  it('keeps queued focused-host repo updates pinned when focus changes', async () => {
    const firstUpdate = deferred<{
      id: string
      ok: true
      result: { repo: Repo }
      _meta: { runtimeId: string }
    }>()
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.update') {
        const { updates } = (args as unknown as { params: { updates: { displayName: string } } })
          .params
        const displayName = updates.displayName
        if (displayName === 'Remote slow') {
          return firstUpdate.promise
        }
        return Promise.resolve({
          id: 'rpc-queued-update',
          ok: true,
          result: { repo: { ...remoteDuplicate, displayName } },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      return Promise.resolve({
        id: 'rpc-other',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-remote' }
      })
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [localDuplicate, remoteDuplicate]
    })

    const first = store.getState().updateRepo('same-repo', { displayName: 'Remote slow' })
    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'env-1',
          method: 'repo.update',
          params: { repo: 'same-repo', updates: { displayName: 'Remote slow' } }
        })
      )
    })

    const second = store.getState().updateRepo('same-repo', { displayName: 'Remote queued' })
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-2' } as never })
    firstUpdate.resolve({
      id: 'rpc-first-update',
      ok: true,
      result: { repo: { ...remoteDuplicate, displayName: 'Remote slow' } },
      _meta: { runtimeId: 'runtime-remote' }
    })

    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'repo.update',
        params: { repo: 'same-repo', updates: { displayName: 'Remote queued' } }
      })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-2', method: 'repo.update' })
    )
    expect(store.getState().repos).toEqual([
      localDuplicate,
      { ...remoteDuplicate, displayName: 'Remote queued' }
    ])
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
      },
      lastVisitedAtByWorktreeId: {
        [localWorktree.id]: 10,
        [remoteWorktree.id]: 20
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
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ [remoteWorktree.id]: 20 })
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
      },
      lastVisitedAtByWorktreeId: {
        [localWorktree.id]: 10,
        [remoteWorktree.id]: 20
      }
    })

    await store.getState().removeProject('same-repo')

    expect(store.getState().repos).toEqual([localDuplicate])
    expect(store.getState().worktreesByRepo['same-repo']).toEqual([localWorktree])
    expect(store.getState().tabsByWorktree[localWorktree.id]).toEqual([
      { id: 'local-tab', worktreeId: localWorktree.id }
    ])
    expect(store.getState().tabsByWorktree[remoteWorktree.id]).toBeUndefined()
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ [localWorktree.id]: 10 })
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
