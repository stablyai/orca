/** Only tombstoned catalog.hostId values block late merges (#8881); an unhydrated saved list or serving-local runtime stamps cannot prove removal. */
import { describe, it, expect, vi } from 'vitest'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import type { Repo } from '../../../../shared/repo-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// All RPCs share this fixture shape; compatibility probes read projects/setups while repo.list reads repos.
const rpcResult = vi.hoisted(() => ({ current: { repos: [] as Repo[], projects: [], setups: [] } }))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  return { ...actual, callRuntimeRpc: vi.fn(async () => rpcResult.current) }
})

const localReposList = vi.fn<() => Promise<Repo[]>>()

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: { repos: { list: localReposList } } }

import { createTestStore, seedStore, TEST_REPO } from './store-test-helpers'

function env(id: string): PublicKnownRuntimeEnvironment {
  return { id } as unknown as PublicKnownRuntimeEnvironment
}

function repo(id: string, extra: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    ...extra
  } as Repo
}

describe('environment-catalog merge guard drops catalogs for a removed env', () => {
  it('fetchRuntimeEnvironmentRepos skips the merge when the catalog env was removed (tombstoned)', async () => {
    const store = createTestStore()
    seedStore(store, {
      repos: [TEST_REPO],
      runtimeEnvironments: [env('env-gone'), env('env-b')]
    })
    // Tombstone env-gone before its in-flight fetch returns.
    store.getState().setRuntimeEnvironments([env('env-b')])
    rpcResult.current = { repos: [repo('ghost')], projects: [], setups: [] }

    await store.getState().fetchRuntimeEnvironmentRepos('env-gone')

    expect(store.getState().repos.map((r) => r.id)).toEqual(['repo1'])
  })

  it('fetchRuntimeEnvironmentRepos merges a catalog whose env is absent but not tombstoned (not yet hydrated)', async () => {
    // On boot, disk catalogs may arrive before the saved list; absence alone cannot block merging.
    const store = createTestStore()
    seedStore(store, { repos: [TEST_REPO], runtimeEnvironments: [] })
    rpcResult.current = { repos: [repo('fresh')], projects: [], setups: [] }

    await store.getState().fetchRuntimeEnvironmentRepos('env-hydrating')

    expect(
      store
        .getState()
        .repos.map((r) => r.id)
        .sort()
    ).toEqual(['fresh', 'repo1'])
  })

  it('fetchRuntimeEnvironmentRepos merges the catalog for a still-saved env id', async () => {
    const store = createTestStore()
    seedStore(store, { repos: [TEST_REPO], runtimeEnvironments: [env('env-saved')] })
    rpcResult.current = { repos: [repo('fresh')], projects: [], setups: [] }

    await store.getState().fetchRuntimeEnvironmentRepos('env-saved')

    expect(
      store
        .getState()
        .repos.map((r) => r.id)
        .sort()
    ).toEqual(['fresh', 'repo1'])
  })

  it("fetchRepos merges a 'local' catalog even when its repos carry runtime stamps", async () => {
    const store = createTestStore()
    seedStore(store, { repos: [TEST_REPO], runtimeEnvironments: [] })
    // A serving instance's own local catalog: hostId 'local', repos runtime-stamped.
    localReposList.mockResolvedValue([
      repo('localStamped', { executionHostId: 'runtime:some-client' })
    ])

    await store.getState().fetchRepos(catalogOwner(store))

    expect(store.getState().repos.map((r) => r.id)).toContain('localStamped')
  })
})

// The catalog these tests read is the one the focused host would have shown.
function catalogOwner(store: {
  getState: () => { settings: { activeRuntimeEnvironmentId?: string | null } | null }
}): { runtimeEnvironmentId: string | null } {
  return { runtimeEnvironmentId: store.getState().settings?.activeRuntimeEnvironmentId ?? null }
}
