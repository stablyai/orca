/**
 * #20811: a repo catalog fetched over a runtime connection that was replaced mid-fetch must not
 * overwrite the current one, and a dropped catalog is not an answer for repo-scoped UI cleanup.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const sshState = vi.hoisted(() => ({ generation: 0 }))

vi.mock('./runtime-environment-ssh', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEnvironmentSshStateGeneration: () => sshState.generation
}))

function repo(id: string, path: string): Repo {
  return { id, path, displayName: id, badgeColor: '#000', addedAt: 1 }
}

const runtimeEnvironmentCall = vi.fn()

function stubRemoteRepoList(remote: Promise<unknown>, onStart: () => void): void {
  runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    if (args.method === 'repo.list') {
      onStart()
      return remote
    }
    return {
      id: 'rpc-other',
      ok: true,
      result: { projects: [], setups: [] },
      _meta: { runtimeId: 'runtime-remote' }
    }
  })
}

beforeEach(() => {
  sshState.generation = 0
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      repos: { list: vi.fn().mockResolvedValue([repo('local-repo', '/local')]) },
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

describe('repo catalogs use the host-catalog fence (#20811)', () => {
  for (const loader of ['all-hosts', 'connect-flow', 'active-target'] as const) {
    it(`drops a ${loader} catalog from a replaced connection`, async () => {
      const remote = Promise.withResolvers<unknown>()
      const started = Promise.withResolvers<void>()
      stubRemoteRepoList(remote.promise, started.resolve)
      const store = createTestStore()
      store.setState({ filterRepoIds: ['gone-repo'] })

      const load =
        loader === 'all-hosts'
          ? store.getState().fetchReposForAllHosts()
          : loader === 'connect-flow'
            ? store.getState().fetchRuntimeEnvironmentRepos('env-1')
            : store.getState().fetchRepos({ runtimeEnvironmentId: 'env-1' })
      await started.promise
      sshState.generation += 1
      remote.resolve({
        id: 'rpc-repo-list',
        ok: true,
        result: { repos: [repo('remote-repo', '/remote')] },
        _meta: { runtimeId: 'runtime-remote' }
      })
      await load

      expect(store.getState().repos.map((entry) => entry.id)).not.toContain('remote-repo')
      if (loader === 'all-hosts') {
        // The dropped catalog is not an answer, so saved repo filters survive.
        expect(store.getState().filterRepoIds).toEqual(['gone-repo'])
      }
    })
  }

  it('keeps the newer all-host load when a superseded one finishes listing hosts late', async () => {
    const olderHosts = Promise.withResolvers<{ id: string; name: string }[]>()
    const listHosts = vi
      .fn()
      .mockReturnValueOnce(olderHosts.promise)
      .mockResolvedValue([{ id: 'env-1', name: 'Remote' }])
    vi.mocked(window.api.runtimeEnvironments).list = listHosts
    const newerRemote = Promise.withResolvers<unknown>()
    const newerStarted = Promise.withResolvers<void>()
    stubRemoteRepoList(newerRemote.promise, newerStarted.resolve)
    const store = createTestStore()

    const older = store.getState().fetchReposForAllHosts()
    await vi.waitFor(() => expect(listHosts).toHaveBeenCalledOnce())
    const newer = store.getState().fetchReposForAllHosts()
    await newerStarted.promise
    olderHosts.resolve([{ id: 'env-1', name: 'Remote' }])
    await older
    newerRemote.resolve({
      id: 'rpc-repo-list',
      ok: true,
      result: { repos: [repo('remote-repo', '/remote')] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await newer

    expect(store.getState().repos.map((entry) => entry.id)).toContain('remote-repo')
  })
})
