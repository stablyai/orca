import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'
import { replaceRuntimeEnvironmentRevisions } from '../../runtime/rpc/environment-revisions/runtime-environment-revision'

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
  replaceRuntimeEnvironmentRevisions([])
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

afterEach(() => {
  replaceRuntimeEnvironmentRevisions([])
})

describe('fetchReposForAllHosts generation', () => {
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
