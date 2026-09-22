import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const { syncFork } = vi.hoisted(() => ({ syncFork: vi.fn() }))

vi.mock('../../runtime/runtime-git-client', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    syncRuntimeGitForkDefaultBranch: syncFork
  }
})

const runtimeCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      repos: { list: vi.fn() },
      runtimeEnvironments: {
        call: (args: RuntimeEnvironmentCallRequest) =>
          createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeCall(args)
      }
    }
  })
})

describe('repo module-lifetime coordinators', () => {
  it('lets a newer runtime fetch in another store supersede the older store request', async () => {
    const { promise: olderList, resolve: resolveOlderList } = Promise.withResolvers<unknown>()
    let repoListCalls = 0
    runtimeCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method !== 'repo.list') {
        return {
          id: `rpc-${args.method}`,
          ok: true,
          result: args.method === 'settings.get' ? { settings: {} } : { projects: [], setups: [] },
          _meta: { runtimeId: 'runtime' }
        }
      }
      repoListCalls++
      return repoListCalls === 1
        ? olderList
        : {
            id: 'rpc-newer',
            ok: true,
            result: { repos: [] },
            _meta: { runtimeId: 'runtime' }
          }
    })
    const firstStore = createTestStore()
    const secondStore = createTestStore()

    const older = firstStore.getState().fetchRuntimeEnvironmentRepos('shared-env')
    await secondStore.getState().fetchRuntimeEnvironmentRepos('shared-env')
    resolveOlderList({
      id: 'rpc-older',
      ok: true,
      result: {
        repos: [
          {
            id: 'stale',
            path: '/stale',
            displayName: 'Stale',
            badgeColor: '#000',
            addedAt: 1
          }
        ]
      },
      _meta: { runtimeId: 'runtime' }
    })

    await expect(older).resolves.toEqual([])
    expect(firstStore.getState().repos).toEqual([])
  })

  it('shares safe-auto fork sync cooldown attempts across store instances', async () => {
    const { promise: sync, resolve: resolveSync } = Promise.withResolvers<void>()
    syncFork.mockReturnValueOnce(sync)
    const safeAutoRepo: Repo = {
      id: 'safe-auto-shared',
      path: '/safe-auto-shared',
      displayName: 'Safe auto',
      badgeColor: '#000',
      addedAt: 1,
      forkSyncMode: 'safe-auto',
      upstream: { owner: 'upstream', repo: 'safe-auto-shared' }
    }
    window.api.repos.list = vi.fn().mockResolvedValue([safeAutoRepo])
    const firstStore = createTestStore()
    const secondStore = createTestStore()

    await firstStore.getState().fetchRepos()
    await secondStore.getState().fetchRepos()

    expect(syncFork).toHaveBeenCalledTimes(1)
    resolveSync()
    await sync
  })
})
