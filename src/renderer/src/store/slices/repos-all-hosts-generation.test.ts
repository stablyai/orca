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

const runtimeEnvironmentCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { list: vi.fn().mockResolvedValue([localRepo]) },
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
