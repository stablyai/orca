import { describe, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { createTestStore } from '../slices/store-test-helpers'
import { makeWorktree } from '../slices/worktrees-slice-test-fixtures'
import { workItemsCacheKey } from '../github/cache/cache-identity'

import type { Repo } from '../../../../shared/repo-types'
import { toast } from 'sonner'
import '../../../../shared/global-settings-test-fixture'
import '../../web/preload-api/web-fallback-api'
import {
  installReposRuntimeRoutingHarness,
  localRepo,
  projectsSetupExistingFolder,
  ptyKill,
  remoteRepo,
  reposRemoveForHost,
  runtimeEnvironmentCall,
  runtimeEnvironmentsList,
  sshRepo
} from './repo-runtime-routing.test-fixture'

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
  it('names an SSH host without a server and offers Connect, never its raw id (#37767)', async () => {
    const store = createTestStore()
    store.setState({ sshTargetLabels: new Map([['ssh-1', 'build box']]) })
    const connect = vi.fn().mockResolvedValue(null)
    Object.assign(window.api, { ssh: { connect } })

    await expect(
      store.getState().setupProjectExistingFolder({
        projectId: 'github:acme/orca',
        hostId: 'ssh:ssh-1',
        path: '/srv/orca',
        kind: 'git'
      })
    ).resolves.toBeNull()

    expect(projectsSetupExistingFolder).not.toHaveBeenCalled()
    const [, options] = vi.mocked(toast.error).mock.calls[0] ?? []
    expect(options?.description).toContain('build box')
    expect(options?.description).not.toContain('ssh-1')
    const action = options?.action
    if (!action || typeof action !== 'object' || !('onClick' in action)) {
      throw new Error('expected a Connect action')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the action ignores its click event.
    action.onClick({} as never)
    expect(connect).toHaveBeenCalledWith({ targetId: 'ssh-1' })
  })

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
    // A refetch signal only: eviction and the retired source owner may each bump it.
    expect(store.getState().workItemsInvalidationNonce).toBeGreaterThan(2)
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
