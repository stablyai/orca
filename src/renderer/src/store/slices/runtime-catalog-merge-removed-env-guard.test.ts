/**
 * Catalog-merge guard coverage for #8881: an in-flight catalog fetch for a runtime
 * env removed mid-load must NOT re-add the purged repos, because nothing
 * re-triggers the purge afterwards. The guard keys on `catalog.hostId` and the
 * *tombstone* set (`removedRuntimeEnvironmentIds`), so only a genuinely-removed env
 * is skipped — a runtime env merely absent from a not-yet-hydrated saved list still
 * merges (else boot would drop legitimate runtime repos), and a still-saved env or a
 * `hostId: 'local'` catalog whose repos carry runtime stamps also merges.
 */
import { describe, it, expect, vi } from 'vitest'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'
import type { Repo } from '../../../../shared/types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// Every runtime RPC (repo.list, project.list, projectHostSetup.list, capability
// probes) resolves this shape — repo.list reads `.repos`; the compatibility probes
// read `.projects` / `.setups`; anything else falls back safely.
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
    // Remove env-gone from the saved list → tombstoned. A catalog fetch for it that
    // was already in flight across the removal must not re-add its repos.
    store.getState().setRuntimeEnvironments([env('env-b')])
    rpcResult.current = { repos: [repo('ghost')], projects: [], setups: [] }

    await store.getState().fetchRuntimeEnvironmentRepos('env-gone')

    expect(store.getState().repos.map((r) => r.id)).toEqual(['repo1'])
  })

  it('fetchRuntimeEnvironmentRepos merges a catalog whose env is absent but not tombstoned (not yet hydrated)', async () => {
    // The P1 the tombstone fixes: on boot the saved list can still be empty while a
    // runtime catalog is enumerated from disk. Absence must NOT skip the merge.
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

    await store.getState().fetchRepos()

    expect(store.getState().repos.map((r) => r.id)).toContain('localStamped')
  })
})
