/**
 * Memory-leak regression: pane-scoped agent-status, unread, and terminal-input
 * maps must be purged when a worktree is removed via the BULK path.
 *
 * These maps are keyed by `${tabId}:${leafId}` (or by tabId for
 * `unreadTerminalTabs`). The single `removeWorktree` path clears them via
 * `shutdownWorktreeTerminals` / `dropAgentStatusByWorktree` /
 * `clearPaneForegroundAgentByWorktree`, but the bulk `purgeWorktreeTerminalState`
 * reducer (used by the authoritative-scan reconcile, remove-project, and the
 * hydration stale-purge) never ran terminal teardown — so an externally-removed
 * worktree (CLI `git worktree remove`, another Orca window, SSH, or a removed
 * project) orphaned one entry per agent pane for the lifetime of the renderer
 * session, plus a phantom unread dock badge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AppState } from '../types'
import type * as AgentStatusModule from '@/lib/agent-status'

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
    list: vi.fn().mockResolvedValue([]),
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

const WT = 'repo1::/path/wt1'
const TAB = 'tab-1'
const PANE = `${TAB}:leaf-a`

function liveEntry(paneKey: string): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'p',
    updatedAt: 0,
    stateStartedAt: 0,
    paneKey,
    stateHistory: []
  }
}

function seedPaneState(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
    },
    tabsByWorktree: { [WT]: [makeTab({ id: TAB, worktreeId: WT })] },
    agentStatusByPaneKey: { [PANE]: liveEntry(PANE) },
    agentLaunchConfigByPaneKey: {
      [PANE]: { launchConfig: {}, registeredAt: 0, identity: {} }
    } as unknown as AppState['agentLaunchConfigByPaneKey'],
    acknowledgedAgentsByPaneKey: { [PANE]: 1 },
    paneForegroundAgentByPaneKey: { [PANE]: { agent: null, shellForeground: true } },
    sleepingAgentSessionsByPaneKey: {
      [PANE]: {}
    } as unknown as AppState['sleepingAgentSessionsByPaneKey'],
    unreadTerminalTabs: { [TAB]: true },
    unreadTerminalPanes: { [PANE]: true },
    unreadAgentCompletionPanes: { [PANE]: true },
    lastTerminalInputAtByPaneKey: { [PANE]: 123 }
  })
}

describe('bulk worktree purge evicts pane-scoped agent/unread/input maps (leak regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('purgeWorktreeTerminalState drops every pane-scoped map for the removed worktree', () => {
    const store = createTestStore()
    seedPaneState(store)

    store.getState().purgeWorktreeTerminalState([WT])

    const s = store.getState()
    expect(s.agentStatusByPaneKey[PANE]).toBeUndefined()
    expect(s.agentLaunchConfigByPaneKey[PANE]).toBeUndefined()
    expect(s.acknowledgedAgentsByPaneKey[PANE]).toBeUndefined()
    expect(s.paneForegroundAgentByPaneKey[PANE]).toBeUndefined()
    expect(s.sleepingAgentSessionsByPaneKey[PANE]).toBeUndefined()
    expect(s.unreadTerminalTabs[TAB]).toBeUndefined()
    expect(s.unreadTerminalPanes[PANE]).toBeUndefined()
    expect(s.unreadAgentCompletionPanes[PANE]).toBeUndefined()
    expect(s.lastTerminalInputAtByPaneKey[PANE]).toBeUndefined()
  })

  it('keeps pane-scoped state for worktrees that are NOT removed', () => {
    const store = createTestStore()
    const OTHER = 'repo1::/path/wt2'
    const OTHER_TAB = 'tab-2'
    const OTHER_PANE = `${OTHER_TAB}:leaf-b`
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: OTHER, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: {
        [WT]: [makeTab({ id: TAB, worktreeId: WT })],
        [OTHER]: [makeTab({ id: OTHER_TAB, worktreeId: OTHER })]
      },
      agentStatusByPaneKey: { [PANE]: liveEntry(PANE), [OTHER_PANE]: liveEntry(OTHER_PANE) },
      unreadTerminalTabs: { [TAB]: true, [OTHER_TAB]: true },
      lastTerminalInputAtByPaneKey: { [PANE]: 1, [OTHER_PANE]: 2 }
    })

    store.getState().purgeWorktreeTerminalState([WT])

    const s = store.getState()
    expect(s.agentStatusByPaneKey[PANE]).toBeUndefined()
    expect(s.agentStatusByPaneKey[OTHER_PANE]).toBeDefined()
    expect(s.unreadTerminalTabs[OTHER_TAB]).toBe(true)
    expect(s.lastTerminalInputAtByPaneKey[OTHER_PANE]).toBe(2)
  })
})
