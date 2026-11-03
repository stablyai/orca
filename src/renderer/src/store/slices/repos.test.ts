import { describe, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { workItemsCacheKey } from '../github/cache-identity'

import type { Repo } from '../../../../shared/repo-types'
import 'sonner'
import '../../../../shared/global-settings-test-fixture'
import '../../web/preload-api/web-fallback-api'
import {
  installReposRuntimeRoutingHarness,
  localRepo,
  ptyKill,
  remoteRepo,
  reposRemoveForHost,
  runtimeEnvironmentCall,
  runtimeEnvironmentsList,
  sshRepo
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

const ownerOf = (repo: Repo) => ({ hostId: getRepoExecutionHostId(repo) })
// Ingest stamps every server row; an unstamped row is this app's own.
const serverRepo: Repo = { ...remoteRepo, executionHostId: 'runtime:env-1' }

describe('repo slice runtime routing', () => {
  it('drops persisted visit timestamps for removed unhydrated SSH repos', async () => {
    const store = createTestStore()
    const sshWorktreeId = `${sshRepo.id}::/home/orca/wt`
    const localWorktreeId = `${localRepo.id}::/local/wt`
    store.setState({
      repos: [sshRepo, localRepo],
      activeRepoId: sshRepo.id,
      lastVisitedAtByWorktreeId: {
        [sshWorktreeId]: 100,
        [localWorktreeId]: 200
      }
    })

    await store.getState().removeProject(sshRepo.id, ownerOf(sshRepo))

    expect(store.getState().repos).toEqual([localRepo])
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ [localWorktreeId]: 200 })
    expect(reposRemoveForHost).toHaveBeenCalledWith({ repoId: sshRepo.id, hostId: 'ssh:ssh-1' })
  })

  it('drops persisted visit timestamps for removed unhydrated runtime repos', async () => {
    runtimeEnvironmentsList.mockResolvedValue([{ id: 'env-1' }])
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-remove-runtime-unhydrated',
      ok: true,
      result: { removed: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    const remoteWorktreeId = `${remoteRepo.id}::/srv/orca/wt`
    const localWorktreeId = `${localRepo.id}::/local/wt`
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [serverRepo, localRepo],
      activeRepoId: remoteRepo.id,
      lastVisitedAtByWorktreeId: {
        [remoteWorktreeId]: 100,
        [localWorktreeId]: 200
      }
    })

    await store.getState().removeProject(remoteRepo.id, ownerOf(serverRepo))

    expect(store.getState().repos).toEqual([localRepo])
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({ [localWorktreeId]: 200 })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.rm',
      params: { repo: remoteRepo.id },
      timeoutMs: 15_000
    })
    expect(reposRemoveForHost).toHaveBeenCalledWith({
      repoId: remoteRepo.id,
      hostId: 'runtime:env-1'
    })
  })

  it('evicts GitHub caches for removed repos using repo id and legacy path keys', async () => {
    const store = createTestStore()
    store.setState({
      repos: [localRepo],
      workItemsInvalidationNonce: 2,
      workItemsCache: {
        [workItemsCacheKey(localRepo.id, 20, '')]: { data: [], fetchedAt: 1 },
        [workItemsCacheKey(localRepo.path, 20, '')]: { data: [], fetchedAt: 1 },
        [workItemsCacheKey('other-repo', 20, '')]: { data: [], fetchedAt: 1 }
      },
      prCache: {
        [`${localRepo.id}::branch`]: { data: {} as never, fetchedAt: 1 },
        [`${localRepo.path}::branch`]: { data: {} as never, fetchedAt: 1 },
        'other-repo::branch': { data: {} as never, fetchedAt: 1 }
      }
    })

    await store.getState().removeProject(localRepo.id, ownerOf(localRepo))

    expect(Object.keys(store.getState().workItemsCache)).toEqual([
      workItemsCacheKey('other-repo', 20, '')
    ])
    expect(Object.keys(store.getState().prCache)).toEqual(['other-repo::branch'])
    expect(store.getState().workItemsInvalidationNonce).toBe(3)
  })

  it('stops remote runtime terminals instead of killing remote ids through local pty IPC', async () => {
    runtimeEnvironmentsList.mockResolvedValue([{ id: 'env-1' }])
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
      repos: [serverRepo],
      worktreesByRepo: {
        [remoteRepo.id]: [
          makeWorktree({ id: worktreeId, repoId: remoteRepo.id, hostId: 'runtime:env-1' })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [{ id: 'tab-1', worktreeId } as never]
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:term-1', 'pty-local-stale']
      }
    })

    await store.getState().removeProject(remoteRepo.id, ownerOf(serverRepo))

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.stop',
      params: { worktree: `id:${worktreeId}` },
      timeoutMs: 15_000
    })
    expect(ptyKill).toHaveBeenCalledWith('pty-local-stale')
    expect(ptyKill).not.toHaveBeenCalledWith('remote:term-1')
  })

  it('cleans up hidden detected worktree state when removing a repo', async () => {
    const store = createTestStore()
    const hiddenWorktree = makeWorktree({
      id: `${localRepo.id}::/local/hidden`,
      repoId: localRepo.id,
      path: '/local/hidden'
    })
    store.setState({
      repos: [localRepo],
      worktreesByRepo: { [localRepo.id]: [] },
      detectedWorktreesByRepo: {
        [localRepo.id]: {
          repoId: localRepo.id,
          authoritative: true,
          source: 'git',
          worktrees: [
            {
              ...hiddenWorktree,
              ownership: 'external',
              selectedCheckout: false,
              visible: false
            }
          ]
        }
      },
      tabsByWorktree: {
        [hiddenWorktree.id]: [{ id: 'tab-hidden', worktreeId: hiddenWorktree.id }] as never
      },
      ptyIdsByTabId: {
        'tab-hidden': ['pty-hidden']
      },
      activeWorktreeId: hiddenWorktree.id
    })

    await store.getState().removeProject(localRepo.id, ownerOf(localRepo))

    expect(store.getState().detectedWorktreesByRepo[localRepo.id]).toBeUndefined()
    expect(store.getState().tabsByWorktree[hiddenWorktree.id]).toBeUndefined()
    expect(store.getState().activeWorktreeId).toBeNull()
    expect(ptyKill).toHaveBeenCalledWith('pty-hidden')
  })
})
