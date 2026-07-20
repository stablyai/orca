import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { createTestStore } from './store-test-helpers'
import {
  installReposRuntimeRoutingHarness,
  reposList,
  reposRemove,
  runtimeEnvironmentCall
} from './repos-runtime-routing-fixture'
import { SAFE_AUTO_FORK_SYNC_COOLDOWN_MS } from './safe-auto-fork-sync-attempts'
import type * as RuntimeGitClient from '../../runtime/runtime-git-client'

const syncRuntimeGitForkDefaultBranch = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

vi.mock('../../runtime/runtime-git-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeGitClient>()),
  syncRuntimeGitForkDefaultBranch
}))

installReposRuntimeRoutingHarness()

const safeAutoRepo = (upstreamOwner: string, overrides: Partial<Repo> = {}): Repo => ({
  id: 'fork-repo',
  path: '/repos/fork',
  displayName: 'Fork',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local',
  forkSyncMode: 'safe-auto',
  upstream: { owner: upstreamOwner, repo: 'upstream-repo' },
  ...overrides
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('safe-auto fork sync attempt lifecycle', () => {
  beforeEach(() => {
    syncRuntimeGitForkDefaultBranch.mockReset()
    syncRuntimeGitForkDefaultBranch.mockResolvedValue({
      status: 'up-to-date',
      originRemote: 'origin',
      upstreamRemote: 'upstream',
      ahead: 0,
      behind: 0
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not reuse a cooldown after the expected upstream identity changes', async () => {
    const store = createTestStore()
    reposList.mockResolvedValue([safeAutoRepo('first-owner')])
    await store.getState().fetchRepos()
    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1))

    reposList.mockResolvedValue([safeAutoRepo('second-owner')])
    await store.getState().fetchRepos()

    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(2))
  })

  it('queues an upstream change behind the current git operation', async () => {
    const firstSync = deferred<{
      status: 'up-to-date'
      originRemote: string
      upstreamRemote: string
      ahead: number
      behind: number
    }>()
    syncRuntimeGitForkDefaultBranch.mockReturnValueOnce(firstSync.promise)
    const store = createTestStore()
    reposList.mockResolvedValue([safeAutoRepo('first-owner')])
    await store.getState().fetchRepos()

    reposList.mockResolvedValue([safeAutoRepo('second-owner')])
    await store.getState().fetchRepos()
    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1)

    firstSync.resolve({
      status: 'up-to-date',
      originRemote: 'origin',
      upstreamRemote: 'upstream',
      ahead: 0,
      behind: 0
    })
    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(2))
    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ owner: 'second-owner' })
    )
  })

  it('keeps one call for a true same-target cooldown', async () => {
    const store = createTestStore()
    reposList.mockResolvedValue([safeAutoRepo('same-owner')])

    await store.getState().fetchRepos()
    await store.getState().fetchRepos()

    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1)
  })

  it('does not share cooldowns across profile auth boundaries', async () => {
    const store = createTestStore()
    reposList.mockResolvedValue([safeAutoRepo('same-owner')])
    store.setState({ activeOrcaProfileId: 'profile-a' })
    await store.getState().fetchRepos()

    store.setState({ activeOrcaProfileId: 'profile-b' })
    await store.getState().fetchRepos()

    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(2)
  })

  it('routes duplicate repo ids through the candidate runtime host', async () => {
    const runtimeRepo = safeAutoRepo('same-owner', {
      path: '/runtime/fork',
      executionHostId: 'runtime:env-1'
    })
    runtimeEnvironmentCall.mockImplementation((args) => {
      if (args.method === 'repo.list') {
        return {
          id: 'rpc-repos',
          ok: true,
          result: { repos: [runtimeRepo] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'rpc-projects',
        ok: true,
        result: args.method === 'project.list' ? { projects: [] } : { setups: [] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    const store = createTestStore()
    store.setState({ repos: [safeAutoRepo('same-owner')] })

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1))
    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ activeRuntimeEnvironmentId: 'env-1' }),
        worktreePath: '/runtime/fork'
      }),
      expect.anything()
    )
  })

  it('retries a rejected attempt after the cooldown without retrying early', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    syncRuntimeGitForkDefaultBranch.mockRejectedValueOnce(new Error('auth unavailable'))
    const store = createTestStore()
    reposList.mockResolvedValue([safeAutoRepo('same-owner')])

    await store.getState().fetchRepos()
    await Promise.resolve()
    await store.getState().fetchRepos()
    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000 + SAFE_AUTO_FORK_SYNC_COOLDOWN_MS)
    await store.getState().fetchRepos()
    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(2)
  })

  it('starts a new cooldown lifecycle after removal and re-add', async () => {
    const store = createTestStore()
    const repo = safeAutoRepo('same-owner')
    reposList.mockResolvedValue([repo])
    reposRemove.mockResolvedValue(undefined)
    await store.getState().fetchRepos()
    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1))

    await store.getState().removeProject(repo.id)
    reposList.mockResolvedValue([repo])
    await store.getState().fetchRepos()

    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(2))
  })

  it('retires cooldowns when catalog reconciliation removes the repo', async () => {
    const store = createTestStore()
    const repo = safeAutoRepo('same-owner')
    reposList.mockResolvedValue([repo])
    await store.getState().fetchRepos()
    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1))

    reposList.mockResolvedValue([])
    await store.getState().fetchRepos()
    reposList.mockResolvedValue([repo])
    await store.getState().fetchRepos()

    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(2))
  })

  it('retires after backend removal even when later cleanup throws', async () => {
    const store = createTestStore()
    const repo = safeAutoRepo('same-owner')
    reposList.mockResolvedValue([repo])
    reposRemove.mockResolvedValue(undefined)
    await store.getState().fetchRepos()
    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1))
    store.setState({
      clearOrcaHookTrustForRepo: vi.fn(() => {
        throw new Error('cleanup failed')
      })
    })

    await store.getState().removeProject(repo.id)
    await store.getState().fetchRepos()

    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(2))
  })

  it('discards a stale runtime catalog after removal while allowing a fresh re-add', async () => {
    const staleList = deferred<{
      id: string
      ok: true
      result: { repos: Repo[] }
      _meta: { runtimeId: string }
    }>()
    const staleRepo = safeAutoRepo('stale-owner', { executionHostId: 'runtime:env-1' })
    const freshRepo = safeAutoRepo('fresh-owner', { executionHostId: 'runtime:env-1' })
    let repoListCalls = 0
    runtimeEnvironmentCall.mockImplementation((args) => {
      if (args.method === 'repo.list') {
        repoListCalls += 1
        return repoListCalls === 1
          ? staleList.promise
          : {
              id: 'rpc-fresh-repos',
              ok: true,
              result: { repos: [freshRepo] },
              _meta: { runtimeId: 'runtime-remote' }
            }
      }
      if (args.method === 'repo.rm') {
        return {
          id: 'rpc-remove',
          ok: true,
          result: { status: 'removed' },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'rpc-compatibility',
        ok: true,
        result: args.method === 'project.list' ? { projects: [] } : { setups: [] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    const store = createTestStore()
    store.setState({ repos: [freshRepo] })

    const staleFetch = store.getState().fetchRuntimeEnvironmentRepos('env-1')
    await store.getState().removeProject(freshRepo.id, { hostId: 'runtime:env-1' })
    await store.getState().fetchRuntimeEnvironmentRepos('env-1')
    staleList.resolve({
      id: 'rpc-stale-repos',
      ok: true,
      result: { repos: [staleRepo] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await staleFetch

    expect(store.getState().repos).toContainEqual(
      expect.objectContaining({ upstream: freshRepo.upstream })
    )
    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1)
  })

  it('retires the old operation when upstream metadata is cleared before removal', async () => {
    const store = createTestStore()
    const repo = safeAutoRepo('same-owner')
    reposList.mockResolvedValue([repo])
    reposRemove.mockResolvedValue(undefined)
    await store.getState().fetchRepos()
    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1))

    store.setState({
      repos: [{ ...repo, upstream: null, forkSyncMode: 'off' }]
    })
    await store.getState().removeProject(repo.id)
    reposList.mockResolvedValue([repo])
    await store.getState().fetchRepos()

    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(2))
  })

  it('waits for a removed lifecycle owner before syncing a same-key replacement', async () => {
    const firstSync = deferred<{
      status: 'up-to-date'
      originRemote: string
      upstreamRemote: string
      ahead: number
      behind: number
    }>()
    syncRuntimeGitForkDefaultBranch.mockReturnValueOnce(firstSync.promise)
    const store = createTestStore()
    const repo = safeAutoRepo('same-owner')
    reposList.mockResolvedValue([repo])
    reposRemove.mockResolvedValue(undefined)
    await store.getState().fetchRepos()
    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1)

    await store.getState().removeProject(repo.id)
    reposList.mockResolvedValue([repo])
    await store.getState().fetchRepos()
    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1)

    firstSync.resolve({
      status: 'up-to-date',
      originRemote: 'origin',
      upstreamRemote: 'upstream',
      ahead: 0,
      behind: 0
    })
    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(2))
  })

  it('clears older profile cooldowns when removal retires a newer in-flight identity', async () => {
    const secondSync = deferred<{
      status: 'up-to-date'
      originRemote: string
      upstreamRemote: string
      ahead: number
      behind: number
    }>()
    syncRuntimeGitForkDefaultBranch.mockResolvedValueOnce({
      status: 'up-to-date',
      originRemote: 'origin',
      upstreamRemote: 'upstream',
      ahead: 0,
      behind: 0
    })
    syncRuntimeGitForkDefaultBranch.mockReturnValueOnce(secondSync.promise)
    const store = createTestStore()
    const repo = safeAutoRepo('same-owner')
    reposList.mockResolvedValue([repo])
    reposRemove.mockResolvedValue(undefined)
    store.setState({ activeOrcaProfileId: 'profile-a' })
    await store.getState().fetchRepos()
    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(1))

    store.setState({ activeOrcaProfileId: 'profile-b' })
    await store.getState().fetchRepos()
    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(2)
    await store.getState().removeProject(repo.id)

    store.setState({ activeOrcaProfileId: 'profile-a' })
    reposList.mockResolvedValue([repo])
    await store.getState().fetchRepos()
    expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(2)

    secondSync.resolve({
      status: 'up-to-date',
      originRemote: 'origin',
      upstreamRemote: 'upstream',
      ahead: 0,
      behind: 0
    })
    await vi.waitFor(() => expect(syncRuntimeGitForkDefaultBranch).toHaveBeenCalledTimes(3))
  })
})
