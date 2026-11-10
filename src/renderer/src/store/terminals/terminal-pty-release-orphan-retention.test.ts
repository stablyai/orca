import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'

import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeTab } from './terminal-tab.test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import { getOrphanTerminalIds } from './terminal-orphan-cleanup'
import { createStoreCascadesMockApi } from '../testing/app-store-cascade-api.test-fixture'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

describe('setActiveWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  // Promote a surviving split pane into the relay slot on exit; otherwise relay-drop clearing can make orphan sweep delete the live tab (#9911).
  it('promotes a surviving pane into the relay slot so a split tab is not orphaned after a relay drop', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const tabId = 'tab-split'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [wt]: [makeTab({ id: tabId, worktreeId: wt, ptyId: 'pty-B' })] },
      ptyIdsByTabId: { [tabId]: ['pty-A', 'pty-B'] },
      // Newest-bound pane B owns the single relay slot.
      lastKnownRelayPtyIdByTabId: { [tabId]: 'pty-B' },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf-a' },
            second: { type: 'leaf', leafId: 'leaf-b' }
          },
          activeLeafId: 'leaf-a',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-a': 'pty-A', 'leaf-b': 'pty-B' }
        }
      },
      // The transiently-absent unified entry is the condition #9911 recovers from.
      unifiedTabsByWorktree: { [wt]: [] }
    })

    // Pane B (the relay-slot owner) exits: the slot must fall back to survivor A.
    store.getState().clearTabPtyId(tabId, 'pty-B')
    expect(store.getState().ptyIdsByTabId[tabId]).toEqual(['pty-A'])
    expect(store.getState().lastKnownRelayPtyIdByTabId[tabId]).toBe('pty-A')

    // Relay drop bulk-clears the row + live index but preserves the relay slot.
    store.getState().clearTabPtyId(tabId)
    const state = store.getState()
    expect(state.ptyIdsByTabId[tabId]).toEqual([])
    expect(state.tabsByWorktree[wt][0].ptyId).toBeNull()
    expect(state.lastKnownRelayPtyIdByTabId[tabId]).toBe('pty-A')
    expect(getOrphanTerminalIds(state, wt)).not.toContain(tabId)
  })
})
