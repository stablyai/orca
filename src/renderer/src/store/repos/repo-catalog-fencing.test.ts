import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from '../slices/store-test-helpers'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const runtimeRepo: Repo = { ...localRepo, id: 'runtime-repo', path: '/srv/runtime' }

const reposList = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
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
          createCompatibleRuntimeStatusResponseIfNeeded(args) ??
          (args.method === 'repo.list'
            ? { id: 'rpc', ok: true, result: { repos: [runtimeRepo] }, _meta: { runtimeId: 'rt' } }
            : {
                id: 'rpc',
                ok: true,
                result: { projects: [], setups: [] },
                _meta: { runtimeId: 'rt' }
              })
      }
    },
    dispatchEvent: vi.fn()
  })
})

type SettlementState = 'pending' | 'settled' | 'rejected'

function trackSettlement(settlement: Promise<void>): { state: () => SettlementState } {
  let state: SettlementState = 'pending'
  settlement.then(
    () => {
      state = 'settled'
    },
    () => {
      state = 'rejected'
    }
  )
  return { state: () => state }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('awaitLocalRepoCatalogSettlement', () => {
  it('waits for a local fetch to start instead of resolving after a runtime-only fetch', async () => {
    const store = createTestStore()
    // A runtime-only fetch bumps the shared generation but loads no local repos.
    await store.getState().fetchRuntimeEnvironmentRepos('env-1')
    expect(store.getState().reposFetchGeneration).toBeGreaterThan(0)
    const settlement = trackSettlement(store.getState().awaitLocalRepoCatalogSettlement())
    await flushMicrotasks()
    expect(settlement.state()).toBe('pending')

    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    await flushMicrotasks()
    expect(settlement.state()).toBe('settled')
    expect(store.getState().repos.map((repo) => repo.id)).toContain('local-repo')
  })

  it('keeps waiting while fetchRepos targets a paired runtime', async () => {
    const store = createTestStore()
    store.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' }
    })
    await store.getState().fetchRepos()
    expect(store.getState().reposFetchGeneration).toBe(1)
    const settlement = trackSettlement(store.getState().awaitLocalRepoCatalogSettlement())
    await flushMicrotasks()
    expect(settlement.state()).toBe('pending')

    await store.getState().fetchRepos({ runtimeEnvironmentId: null })
    await flushMicrotasks()
    expect(settlement.state()).toBe('settled')
  })

  it('rejects when the first local fetch it waited for fails', async () => {
    reposList.mockRejectedValueOnce(new Error('catalog failed'))
    const store = createTestStore()
    const settlement = trackSettlement(store.getState().awaitLocalRepoCatalogSettlement())
    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    await flushMicrotasks()
    expect(settlement.state()).toBe('rejected')
  })
})
