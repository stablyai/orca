import { describe, it, expect, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'
import { createTestStore } from '../store-test-helpers'
import {
  buildHydratedWorkspaceFixture,
  HYDRATED_TAB_COUNT,
  HYDRATED_WORKSPACE_COUNT,
  RECONCILIATION_WRITABLE_KEYS
} from './hydrated-workspace-reconciliation-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createTabsSliceMockApi()

// Approximates the renderer's live non-React store-subscriber population.
const SUBSCRIBER_COUNT = 1200

type Store = ReturnType<typeof createTestStore>

function hydrateFixtureStore(): { store: Store; workspaceIds: string[] } {
  const fixture = buildHydratedWorkspaceFixture()
  expect(fixture.workspaceIds).toHaveLength(HYDRATED_WORKSPACE_COUNT)
  expect(fixture.tabCount).toBe(HYDRATED_TAB_COUNT)
  const store = createTestStore()
  store.setState(fixture.state)
  return { store, workspaceIds: fixture.workspaceIds }
}

function countNotifications(store: Store, run: () => void): number {
  let notifications = 0
  const unsubscribes = Array.from({ length: SUBSCRIBER_COUNT }, () =>
    store.subscribe(() => {
      notifications += 1
    })
  )
  try {
    run()
  } finally {
    for (const unsubscribe of unsubscribes) {
      unsubscribe()
    }
  }
  return notifications
}

/** Group ids for restored legacy terminals are minted, so pin them to compare states. */
function withDeterministicUuids<T>(run: () => T): T {
  let counter = 0
  const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => {
    counter += 1
    return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
  })
  try {
    return run()
  } finally {
    spy.mockRestore()
  }
}

function reconciliationSnapshot(store: Store): Record<string, unknown> {
  const state = store.getState() as unknown as Record<string, unknown>
  return Object.fromEntries(RECONCILIATION_WRITABLE_KEYS.map((key) => [key, state[key]]))
}

describe('whole-session workspace tab-model reconciliation', () => {
  it('collapses a 193-workspace hydration to one store write', () => {
    const perWorkspace = hydrateFixtureStore()
    const perWorkspaceNotifications = countNotifications(perWorkspace.store, () => {
      for (const worktreeId of perWorkspace.workspaceIds) {
        perWorkspace.store.getState().reconcileWorktreeTabModel(worktreeId)
      }
    })

    const batched = hydrateFixtureStore()
    const batchedNotifications = countNotifications(batched.store, () => {
      batched.store.getState().reconcileWorktreeTabModels(batched.workspaceIds)
    })

    // The fixture must actually be write-heavy, or the collapse proves nothing.
    expect(perWorkspaceNotifications / SUBSCRIBER_COUNT).toBeGreaterThan(100)
    expect(batchedNotifications).toBe(SUBSCRIBER_COUNT)
  })

  it('leaves the store byte-identical to the per-workspace path', () => {
    const perWorkspace = hydrateFixtureStore()
    withDeterministicUuids(() => {
      for (const worktreeId of perWorkspace.workspaceIds) {
        perWorkspace.store.getState().reconcileWorktreeTabModel(worktreeId)
      }
    })
    const expected = reconciliationSnapshot(perWorkspace.store)

    const batched = hydrateFixtureStore()
    withDeterministicUuids(() => {
      batched.store.getState().reconcileWorktreeTabModels(batched.workspaceIds)
    })
    const actual = reconciliationSnapshot(batched.store)

    expect(actual).toEqual(expected)
    // Object key order is observable through Object.keys/entries iteration in
    // selectors and session serialization, so equal values are not enough.
    for (const key of RECONCILIATION_WRITABLE_KEYS) {
      const actualValue = actual[key]
      const expectedValue = expected[key]
      if (actualValue && typeof actualValue === 'object' && !Array.isArray(actualValue)) {
        expect([key, Object.keys(actualValue)]).toEqual([key, Object.keys(expectedValue as object)])
      }
    }
  })

  it('re-reconciling the batched result is a no-op, as it is for the per-workspace path', () => {
    const { store, workspaceIds } = hydrateFixtureStore()
    store.getState().reconcileWorktreeTabModels(workspaceIds)
    const settled = reconciliationSnapshot(store)

    const notifications = countNotifications(store, () => {
      store.getState().reconcileWorktreeTabModels(workspaceIds)
    })

    expect(notifications).toBe(0)
    expect(reconciliationSnapshot(store)).toEqual(settled)
  })

  it('indexes openFiles once instead of rescanning it per workspace', () => {
    const { store, workspaceIds } = hydrateFixtureStore()
    const openFiles = store.getState().openFiles
    let scans = 0
    store.setState({
      openFiles: new Proxy(openFiles, {
        get(target, property, receiver) {
          if (property === 'filter') {
            scans += 1
          }
          return Reflect.get(target, property, receiver)
        }
      })
    })

    store.getState().reconcileWorktreeTabModels(workspaceIds)

    expect(scans).toBe(0)
  })
})
