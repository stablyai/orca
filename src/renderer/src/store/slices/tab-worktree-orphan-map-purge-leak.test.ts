/** Removal must evict detached-name, foreground-last-seen and consumed-startup guards; fresh tab/worktree IDs cannot reclaim leaked module entries. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  getForegroundTerminalTabLastSeenAtById,
  resetForegroundTerminalTabIdsForTests,
  setForegroundTerminalTabIds
} from '@/lib/foreground-terminal-tabs'
import {
  beginAgentStartupDeliveryAttempt,
  resetAgentStartupDelayedDeliveryForTests
} from '@/lib/agent-startup-delayed-delivery'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: {
    remove: vi.fn().mockResolvedValue(undefined),
    forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true }),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore, makeWorktree, makeTab } from './store-test-helpers'
import {
  getDetachedHeadAutoDerivedDisplayNameForTests,
  setDetachedHeadAutoDerivedDisplayNameForTests
} from './worktrees'

const WT1 = 'repo1::/path/wt1'
const WT2 = 'repo1::/path/wt2'
const TAB1 = 'tab-wt1'
const TAB2 = 'tab-wt2'
const TOKEN1 = 'launch-1'
const TOKEN2 = 'launch-2'

function seedMaps(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
        makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
      ]
    },
    tabsByWorktree: {
      [WT1]: [makeTab({ id: TAB1, worktreeId: WT1 })],
      [WT2]: [makeTab({ id: TAB2, worktreeId: WT2 })]
    }
  })
  setDetachedHeadAutoDerivedDisplayNameForTests(WT1, 'wt1 (a1b2c3d)')
  setDetachedHeadAutoDerivedDisplayNameForTests(WT2, 'wt2 (e4f5g6h)')
  setForegroundTerminalTabIds([TAB1, TAB2])
  expect(
    beginAgentStartupDeliveryAttempt({ worktreeId: WT1, tabId: TAB1, launchToken: TOKEN1 })
  ).toBe(true)
  expect(
    beginAgentStartupDeliveryAttempt({ worktreeId: WT2, tabId: TAB2, launchToken: TOKEN2 })
  ).toBe(true)
}

// A second begin succeeds only after guard eviction, observing cleanup without reading module internals.
function startupGuardCleared(worktreeId: string, tabId: string, launchToken: string): boolean {
  return beginAgentStartupDeliveryAttempt({ worktreeId, tabId, launchToken })
}

describe('tab/worktree removal evicts the module maps it previously leaked', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.remove.mockResolvedValue(undefined)
    resetForegroundTerminalTabIdsForTests()
    resetAgentStartupDelayedDeliveryForTests()
  })

  afterEach(() => {
    resetForegroundTerminalTabIdsForTests()
    resetAgentStartupDelayedDeliveryForTests()
  })

  it('bulk purgeWorktreeTerminalState drops the removed worktree/tab entries only', () => {
    const store = createTestStore()
    seedMaps(store)

    store.getState().purgeWorktreeTerminalState([WT1])

    expect(getDetachedHeadAutoDerivedDisplayNameForTests(WT1)).toBeUndefined()
    expect(getForegroundTerminalTabLastSeenAtById()[TAB1]).toBeUndefined()
    expect(startupGuardCleared(WT1, TAB1, TOKEN1)).toBe(true)
    expect(getDetachedHeadAutoDerivedDisplayNameForTests(WT2)).toBe('wt2 (e4f5g6h)')
    expect(getForegroundTerminalTabLastSeenAtById()[TAB2]).toBeGreaterThan(0)
    expect(startupGuardCleared(WT2, TAB2, TOKEN2)).toBe(false)
  })

  it('single removeWorktree drops the removed worktree/tab entries only', async () => {
    const store = createTestStore()
    seedMaps(store)

    const result = await store.getState().removeWorktree({ id: WT1, executionHostId: null })
    expect(result).toEqual({ ok: true })

    expect(getDetachedHeadAutoDerivedDisplayNameForTests(WT1)).toBeUndefined()
    expect(getForegroundTerminalTabLastSeenAtById()[TAB1]).toBeUndefined()
    expect(startupGuardCleared(WT1, TAB1, TOKEN1)).toBe(true)
    expect(getDetachedHeadAutoDerivedDisplayNameForTests(WT2)).toBe('wt2 (e4f5g6h)')
    expect(getForegroundTerminalTabLastSeenAtById()[TAB2]).toBeGreaterThan(0)
    expect(startupGuardCleared(WT2, TAB2, TOKEN2)).toBe(false)
  })

  it('closeTab drops the closed tab foreground + startup entries only', () => {
    const store = createTestStore()
    seedMaps(store)

    store.getState().closeTab(TAB1)

    // closeTab is tab-scoped: the tab-keyed maps drop, the worktree-keyed one stays.
    expect(getForegroundTerminalTabLastSeenAtById()[TAB1]).toBeUndefined()
    expect(startupGuardCleared(WT1, TAB1, TOKEN1)).toBe(true)
    expect(getForegroundTerminalTabLastSeenAtById()[TAB2]).toBeGreaterThan(0)
    expect(startupGuardCleared(WT2, TAB2, TOKEN2)).toBe(false)
  })
})
