import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

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
  badgeColor: '#000',
  addedAt: 1
}

const staleRemoteRepo: Repo = {
  ...remoteRepo,
  path: '/remote-stale',
  displayName: 'Remote stale'
}

const freshRemoteRepo: Repo = {
  ...remoteRepo,
  path: '/remote-fresh',
  displayName: 'Remote fresh'
}

const runtimeEnvironmentCall = vi.fn()
const reposList = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  reposList.mockReset()
  reposList.mockResolvedValue([localRepo])
  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: {
        list: vi.fn().mockResolvedValue([]),
        listHostSetups: vi.fn().mockResolvedValue([])
      },
      runtimeEnvironments: {
        list: vi.fn().mockResolvedValue([{ id: 'env-1', name: 'Remote' }]),
        call: (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
      }
    },
    dispatchEvent: vi.fn()
  })
})

describe('fetchReposForAllHosts generation', () => {
  it('settles startup hydration after the local catalog without waiting for remotes', async () => {
    let resolveRemote!: (value: unknown) => void
    let markRemoteStarted!: () => void
    const remote = new Promise((resolve) => {
      resolveRemote = resolve
    })
    const remoteStarted = new Promise<void>((resolve) => {
      markRemoteStarted = resolve
    })
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        markRemoteStarted()
        return remote
      }
      return {
        id: 'rpc-other',
        ok: true,
        result: { projects: [], setups: [] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    const store = createTestStore()

    const load = store.getState().fetchReposForAllHosts()
    await remoteStarted
    await store.getState().awaitLocalRepoCatalogSettlement()

    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo'])

    resolveRemote({
      id: 'rpc-repo-list',
      ok: true,
      result: { repos: [remoteRepo] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await load
  })

  it('does not let a remote refresh supersede or delay local startup settlement', async () => {
    let resolveLocal!: (repos: Repo[]) => void
    let resolveRemote!: (value: unknown) => void
    const local = new Promise<Repo[]>((resolve) => {
      resolveLocal = resolve
    })
    const remote = new Promise((resolve) => {
      resolveRemote = resolve
    })
    reposList.mockReturnValueOnce(local)
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        return remote
      }
      return {
        id: 'rpc-other',
        ok: true,
        result: { projects: [], setups: [] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    const startup = store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    const remoteRefresh = store.getState().fetchRepos()
    let remoteSettled = false
    void remoteRefresh.then(() => {
      remoteSettled = true
    })

    resolveLocal([localRepo])
    await startup
    await store.getState().awaitLocalRepoCatalogSettlement()

    expect(remoteSettled).toBe(false)
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo'])

    resolveRemote({
      id: 'rpc-repo-list',
      ok: true,
      result: { repos: [remoteRepo] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await remoteRefresh
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo', 'remote-repo'])
  })

  it('keeps a newer Connect-flow catalog when an older all-host response resolves last', async () => {
    let resolveOlder!: (value: unknown) => void
    let markOlderStarted!: () => void
    const older = new Promise((resolve) => {
      resolveOlder = resolve
    })
    const olderStarted = new Promise<void>((resolve) => {
      markOlderStarted = resolve
    })
    let repoListCalls = 0
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method !== 'repo.list') {
        return {
          id: 'rpc-other',
          ok: true,
          result: { projects: [], setups: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      repoListCalls++
      if (repoListCalls === 1) {
        markOlderStarted()
        return older
      }
      return {
        id: 'rpc-fresh',
        ok: true,
        result: { repos: [freshRemoteRepo] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    const store = createTestStore()

    const allHosts = store.getState().fetchReposForAllHosts()
    await olderStarted
    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    resolveOlder({
      id: 'rpc-stale',
      ok: true,
      result: { repos: [staleRemoteRepo] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await allHosts

    expect(store.getState().repos.find((repo) => repo.id === remoteRepo.id)?.path).toBe(
      freshRemoteRepo.path
    )
  })

  it('keeps a newer all-host catalog when an older Connect-flow response resolves last', async () => {
    let resolveOlder!: (value: unknown) => void
    const older = new Promise((resolve) => {
      resolveOlder = resolve
    })
    let repoListCalls = 0
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method !== 'repo.list') {
        return {
          id: 'rpc-other',
          ok: true,
          result: { projects: [], setups: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      repoListCalls++
      return repoListCalls === 1
        ? older
        : {
            id: 'rpc-fresh',
            ok: true,
            result: { repos: [freshRemoteRepo] },
            _meta: { runtimeId: 'runtime-remote' }
          }
    })
    const store = createTestStore()

    const connect = store.getState().fetchRuntimeEnvironmentRepos('env-1')
    await store.getState().fetchReposForAllHosts()

    resolveOlder({
      id: 'rpc-stale',
      ok: true,
      result: { repos: [staleRemoteRepo] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await connect

    expect(store.getState().repos.find((repo) => repo.id === remoteRepo.id)?.path).toBe(
      freshRemoteRepo.path
    )
  })

  it('does not validate repo UI from a superseded refresh', async () => {
    let resolveOlderRemote!: (value: unknown) => void
    let resolveNewerRemote!: (value: unknown) => void
    let markOlderRemoteStarted!: () => void
    let markNewerRemoteStarted!: () => void
    const olderRemote = new Promise((resolve) => {
      resolveOlderRemote = resolve
    })
    const newerRemote = new Promise((resolve) => {
      resolveNewerRemote = resolve
    })
    const olderRemoteStarted = new Promise<void>((resolve) => {
      markOlderRemoteStarted = resolve
    })
    const newerRemoteStarted = new Promise<void>((resolve) => {
      markNewerRemoteStarted = resolve
    })
    let repoListCalls = 0
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method !== 'repo.list') {
        return {
          id: 'rpc-other',
          ok: true,
          result: { projects: [], setups: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      repoListCalls++
      if (repoListCalls === 1) {
        markOlderRemoteStarted()
        return olderRemote
      }
      markNewerRemoteStarted()
      return newerRemote
    })
    const store = createTestStore()
    store.setState({
      activeRepoId: 'remote-repo',
      filterRepoIds: ['remote-repo'],
      trustedOrcaHooks: { 'remote-repo': { all: { approvedAt: 1 } } }
    })
    const response = {
      id: 'rpc-repo-list',
      ok: true,
      result: { repos: [remoteRepo] },
      _meta: { runtimeId: 'runtime-remote' }
    }

    const olderFetch = store.getState().fetchReposForAllHosts()
    await olderRemoteStarted
    const newerFetch = store.getState().fetchReposForAllHosts()
    await newerRemoteStarted
    resolveOlderRemote(response)
    await olderFetch

    expect(store.getState().activeRepoId).toBe('remote-repo')
    expect(store.getState().filterRepoIds).toEqual(['remote-repo'])
    expect(store.getState().trustedOrcaHooks).toEqual({
      'remote-repo': { all: { approvedAt: 1 } }
    })

    resolveNewerRemote(response)
    await newerFetch
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo', 'remote-repo'])
  })
})
