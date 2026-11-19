import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from './types'
import { createTestStore, seedStore } from './testing/app-store-test-fixture'
import { makeTab } from './terminals/testing/terminal-tab.test-fixture'
import { makePersistedUI } from './slices/ui/ui-slice-test-harness'
import { AcceptedAgentStatuses } from './slices/agent-status/status-ownership/accepted-agent-statuses'

// Perf contract (#43945): at 1,900 workspaces every store publication wakes ~4,400 subscribers, and an agent-row
// click published ~12 times where a card-body click published ~4. Its redundant parts must publish nothing, and
// main's echo of a UI write must change only the field that differs.

const NOW = 1_800_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

function publications(store: StoreApi<AppState>): () => number {
  let count = 0
  store.subscribe(() => {
    count += 1
  })
  return () => count
}

it('re-selecting the current terminal tab and tab type publishes nothing', () => {
  const store = createTestStore()
  seedStore(store, {
    activeWorktreeId: 'wt-1',
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] },
    activeTabId: 'tab-1',
    activeTabIdByWorktree: { 'wt-1': 'tab-1' },
    activeTabType: 'terminal',
    activeTabTypeByWorktree: { 'wt-1': 'terminal' }
  })
  const count = publications(store)

  store.getState().setActiveTab('tab-1')
  store.getState().setActiveTabType('terminal', 'wt-1')

  expect(count()).toBe(0)
})

it('re-acknowledging an agent that is already read publishes nothing', () => {
  const store = createTestStore()
  seedStore(store, {
    agentStatusByPaneKey: new AcceptedAgentStatuses(),
    acknowledgedAgentsByPaneKey: { 'tab-1:leaf-1': NOW - 60_000 }
  })
  const count = publications(store)

  store.getState().acknowledgeAgents(['tab-1:leaf-1'])

  expect(count()).toBe(0)
})

it("main's echo of a UI write publishes once and changes only the field that differs", () => {
  const store = createTestStore()
  const saved = {
    collapsedGroups: ['repo:a'],
    gitGraphFiltersByWorktree: { a: 'all' as const },
    sidebarWidth: 300
  }
  store.getState().hydratePersistedUI(makePersistedUI(saved), 'startup')
  const before = store.getState()
  const count = publications(store)

  store.getState().hydratePersistedUI(makePersistedUI({ ...saved, sidebarWidth: 320 }))

  const previous = new Map(Object.entries(before))
  const changed = Object.entries(store.getState())
    .filter(([key, value]) => value !== previous.get(key))
    .map(([key]) => key)
    .toSorted()
  expect(count()).toBe(1)
  // The write baseline moves with every hydration; before #43945 it replaced 27 fields here.
  expect(changed).toEqual([
    'persistedUIWriteBaseline',
    'persistedUIWriteBaselineGeneration',
    'sidebarWidth'
  ])
})
