import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'

const { syncFork } = vi.hoisted(() => ({ syncFork: vi.fn() }))

vi.mock('../../runtime/source-control/git/runtime-git-sync-client', async (importOriginal) => {
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
  // Why same store: catalog fences are per store; another store's fetch is not this store's answer.
  it('lets a newer runtime fetch supersede the older request', async () => {
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

    const older = firstStore.getState().fetchRuntimeEnvironmentRepos('shared-env')
    await firstStore.getState().fetchRuntimeEnvironmentRepos('shared-env')
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
})
