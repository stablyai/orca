/**
 * Memory-leak regression: seven per-tab / per-pty terminal+agent store maps were
 * evicted on the SINGLE removeWorktree path (via closeTab / shutdownWorktreeTerminals)
 * but NOT on the BULK path — `buildWorktreePurgeState`, reached by removeProject, the
 * external-worktree-removal authoritative-scan reconcile, and the hydration-stale
 * reconcile. That path runs no terminal teardown, so before the fix each map stranded
 * an entry per tab/pane of every externally-removed worktree for the renderer's whole
 * session (unbounded across add/remove-repo cycles). tabId and ptyId are ephemeral,
 * never-reused key spaces.
 *
 * Tab-keyed (evicted via the doomed-tab set):
 *   lastKnownRelayPtyIdByTabId, pendingInitialCwdByTabId,
 *   pendingIssueCommandSplitByTabId, pendingSetupSplitByTabId, pendingStartupByTabId
 * Pty-keyed (evicted via the doomed-pty set derived from ptyIdsByTabId):
 *   codexRestartNoticeByPtyId, migrationUnsupportedByPtyId
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
  worktrees: { list: vi.fn().mockResolvedValue([]), remove: vi.fn().mockResolvedValue(undefined) },
  pty: { kill: vi.fn().mockResolvedValue(undefined) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore, makeWorktree, makeTab } from './store-test-helpers'

const WT1 = 'repo1::/path/wt1'
const WT2 = 'repo1::/path/wt2'
const TAB1 = 'tab-wt1'
const TAB2 = 'tab-wt2'
const PTY1 = 'pty-wt1'
const PTY2 = 'pty-wt2'

function seedMaps(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
        makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
      ]
    },
    tabsByWorktree: {
      [WT1]: [makeTab({ id: TAB1, worktreeId: WT1, ptyId: PTY1 })],
      [WT2]: [makeTab({ id: TAB2, worktreeId: WT2, ptyId: PTY2 })]
    },
    // Drives the doomed-ptyId derivation in buildWorktreePurgeState.
    ptyIdsByTabId: { [TAB1]: [PTY1], [TAB2]: [PTY2] },
    lastKnownRelayPtyIdByTabId: { [TAB1]: PTY1, [TAB2]: PTY2 },
    pendingInitialCwdByTabId: { [TAB1]: '/path/wt1', [TAB2]: '/path/wt2' },
    pendingIssueCommandSplitByTabId: {
      [TAB1]: { command: 'a' },
      [TAB2]: { command: 'b' }
    },
    pendingSetupSplitByTabId: {
      [TAB1]: { command: 'setup-a', direction: 'vertical' },
      [TAB2]: { command: 'setup-b', direction: 'vertical' }
    },
    pendingStartupByTabId: { [TAB1]: { command: 'start-a' }, [TAB2]: { command: 'start-b' } },
    codexRestartNoticeByPtyId: {
      [PTY1]: { previousAccountLabel: 'a1', nextAccountLabel: 'a2' },
      [PTY2]: { previousAccountLabel: 'b1', nextAccountLabel: 'b2' }
    },
    migrationUnsupportedByPtyId: {
      [PTY1]: {
        ptyId: PTY1,
        paneKey: `${TAB1}:leaf-1`,
        reason: 'legacy-numeric-pane-key',
        source: 'local',
        updatedAt: 1
      },
      [PTY2]: {
        ptyId: PTY2,
        paneKey: `${TAB2}:leaf-1`,
        reason: 'legacy-numeric-pane-key',
        source: 'local',
        updatedAt: 2
      }
    }
  })
}

describe('bulk worktree purge evicts the per-tab/per-pty terminal maps it previously leaked', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drops removed worktree entries (both tabId- and ptyId-keyed), retains survivors', () => {
    const store = createTestStore()
    seedMaps(store)

    store.getState().purgeWorktreeTerminalState([WT1])
    const s = store.getState()

    // Removed worktree's tab/pty: every map evicted.
    expect(s.lastKnownRelayPtyIdByTabId[TAB1]).toBeUndefined()
    expect(s.pendingInitialCwdByTabId[TAB1]).toBeUndefined()
    expect(s.pendingIssueCommandSplitByTabId[TAB1]).toBeUndefined()
    expect(s.pendingSetupSplitByTabId[TAB1]).toBeUndefined()
    expect(s.pendingStartupByTabId[TAB1]).toBeUndefined()
    expect(s.codexRestartNoticeByPtyId[PTY1]).toBeUndefined()
    expect(s.migrationUnsupportedByPtyId[PTY1]).toBeUndefined()

    // Surviving worktree's tab/pty: every entry retained (no over-eviction).
    expect(s.lastKnownRelayPtyIdByTabId[TAB2]).toBe(PTY2)
    expect(s.pendingInitialCwdByTabId[TAB2]).toBe('/path/wt2')
    expect(s.pendingIssueCommandSplitByTabId[TAB2]).toEqual({ command: 'b' })
    expect(s.pendingSetupSplitByTabId[TAB2]).toEqual({ command: 'setup-b', direction: 'vertical' })
    expect(s.pendingStartupByTabId[TAB2]).toEqual({ command: 'start-b' })
    expect(s.codexRestartNoticeByPtyId[PTY2]).toBeDefined()
    expect(s.migrationUnsupportedByPtyId[PTY2]).toBeDefined()
  })
})
