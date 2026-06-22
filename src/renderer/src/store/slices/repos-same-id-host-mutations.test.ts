import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { createTestStore, makeWorktree } from './store-test-helpers'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const repoId = 'github:stablyai/orca'

const baseRepo: Repo = {
  id: repoId,
  path: '/env-one/orca',
  displayName: 'Orca',
  badgeColor: '#111',
  addedAt: 1
}

const reposRemove = vi.fn()
const reposReorder = vi.fn()
const ptyKill = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

function runtimeRepo(environmentId: string, path: string, displayName: string): Repo {
  return {
    ...baseRepo,
    path,
    displayName,
    executionHostId: `runtime:${environmentId}`
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposRemove.mockReset()
  reposReorder.mockReset()
  ptyKill.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'rpc-same-id-host-mutation',
    ok: true,
    result: { status: 'applied' },
    _meta: { runtimeId: 'runtime-remote' }
  })
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: {
        remove: reposRemove,
        reorder: reposReorder
      },
      pty: { kill: ptyKill },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice same-id host mutations', () => {
  it('keeps sibling host repos and worktrees when removing the active remote host row', async () => {
    const envOneRepo = runtimeRepo('env-1', '/env-one/orca', 'Orca on env one')
    const envTwoRepo = runtimeRepo('env-2', '/env-two/orca', 'Orca on env two')
    const envOneWorktree = makeWorktree({
      id: `${repoId}::/env-one/wt`,
      repoId,
      path: '/env-one/wt',
      hostId: 'runtime:env-1'
    })
    const envTwoWorktree = makeWorktree({
      id: `${repoId}::/env-two/wt`,
      repoId,
      path: '/env-two/wt',
      hostId: 'runtime:env-2'
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [envOneRepo, envTwoRepo],
      activeRepoId: repoId,
      filterRepoIds: [repoId],
      worktreesByRepo: { [repoId]: [envOneWorktree, envTwoWorktree] },
      detectedWorktreesByRepo: {
        [repoId]: {
          repoId,
          authoritative: true,
          source: 'git',
          worktrees: [
            {
              ...envOneWorktree,
              ownership: 'orca-managed',
              selectedCheckout: false,
              visible: true
            },
            { ...envTwoWorktree, ownership: 'orca-managed', selectedCheckout: false, visible: true }
          ]
        }
      },
      tabsByWorktree: {
        [envOneWorktree.id]: [{ id: 'tab-env-one', worktreeId: envOneWorktree.id }] as never,
        [envTwoWorktree.id]: [{ id: 'tab-env-two', worktreeId: envTwoWorktree.id }] as never
      },
      ptyIdsByTabId: {
        'tab-env-one': ['remote:env-one'],
        'tab-env-two': ['remote:env-two']
      },
      lastVisitedAtByWorktreeId: {
        [envOneWorktree.id]: 1,
        [envTwoWorktree.id]: 2
      }
    })

    await store.getState().removeProject(repoId)

    expect(store.getState().repos).toEqual([envTwoRepo])
    expect(store.getState().worktreesByRepo[repoId]).toEqual([envTwoWorktree])
    expect(store.getState().detectedWorktreesByRepo[repoId]?.worktrees).toEqual([
      expect.objectContaining({ id: envTwoWorktree.id, hostId: 'runtime:env-2' })
    ])
    expect(store.getState().tabsByWorktree[envOneWorktree.id]).toBeUndefined()
    expect(store.getState().tabsByWorktree[envTwoWorktree.id]).toEqual([
      { id: 'tab-env-two', worktreeId: envTwoWorktree.id }
    ])
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ [envTwoWorktree.id]: 2 })
    expect(store.getState().activeRepoId).toBeNull()
    expect(store.getState().filterRepoIds).toEqual([repoId])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.rm',
      params: { repo: repoId },
      timeoutMs: 15_000
    })
    expect(reposRemove).not.toHaveBeenCalled()
  })

  it('removes legacy local worktrees without dropping a same-id runtime sibling', async () => {
    const legacyLocalRepo = { ...baseRepo, path: '/local/orca', displayName: 'Local Orca' }
    const envRepo = runtimeRepo('env-1', '/env-one/orca', 'Orca on env one')
    const legacyLocalWorktree = makeWorktree({
      id: `${repoId}::/local/wt`,
      repoId,
      path: '/local/wt'
    })
    const envWorktree = makeWorktree({
      id: `${repoId}::/env-one/wt`,
      repoId,
      path: '/env-one/wt',
      hostId: 'runtime:env-1'
    })
    const store = createTestStore()
    store.setState({
      repos: [legacyLocalRepo, envRepo],
      worktreesByRepo: { [repoId]: [legacyLocalWorktree, envWorktree] },
      tabsByWorktree: {
        [legacyLocalWorktree.id]: [
          { id: 'tab-local', worktreeId: legacyLocalWorktree.id }
        ] as never,
        [envWorktree.id]: [{ id: 'tab-env', worktreeId: envWorktree.id }] as never
      },
      ptyIdsByTabId: {
        'tab-local': ['local-pty'],
        'tab-env': ['remote:env-one']
      },
      lastVisitedAtByWorktreeId: {
        [legacyLocalWorktree.id]: 1,
        [envWorktree.id]: 2
      }
    })

    await store.getState().removeProject(repoId)

    expect(reposRemove).toHaveBeenCalledWith({ repoId })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'repo.rm' })
    )
    expect(store.getState().repos).toEqual([envRepo])
    expect(store.getState().worktreesByRepo[repoId]).toEqual([envWorktree])
    expect(store.getState().tabsByWorktree[legacyLocalWorktree.id]).toBeUndefined()
    expect(store.getState().tabsByWorktree[envWorktree.id]).toEqual([
      { id: 'tab-env', worktreeId: envWorktree.id }
    ])
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ [envWorktree.id]: 2 })
  })

  it('keeps same-id repos from distinct hosts when reordering', async () => {
    const envOneRepo = runtimeRepo('env-1', '/env-one/orca', 'Orca on env one')
    const envTwoRepo = runtimeRepo('env-2', '/env-two/orca', 'Orca on env two')
    const store = createTestStore()
    store.setState({ repos: [envOneRepo, envTwoRepo] })

    await store.getState().reorderRepos([repoId, repoId])

    expect(store.getState().repos).toEqual([envOneRepo, envTwoRepo])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.reorder',
      params: { orderedIds: [repoId] },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-2',
      method: 'repo.reorder',
      params: { orderedIds: [repoId] },
      timeoutMs: 15_000
    })
  })
})
