/**
 * Memory-leak regression: nine per-tab / per-pty terminal+agent store maps were
 * evicted on the SINGLE removeWorktree path (via closeTab / shutdownWorktreeTerminals)
 * but NOT on the BULK path — `buildWorktreePurgeState`, reached by removeProject, the
 * external-worktree-removal authoritative-scan reconcile, and the hydration-stale
 * reconcile. That path runs no terminal teardown, so before the fix each map stranded
 * an entry per tab/pane of every externally-removed worktree for the renderer's whole
 * session (unbounded across add/remove-repo cycles). tabId and ptyId are ephemeral,
 * never-reused key spaces.
 *
 * Tab-keyed (evicted via the doomed-tab set):
 *   lastKnownRelayPtyIdByTabId, pendingReconnectPtyIdByTabId,
 *   deferredSshSessionIdsByTabId, pendingInitialCwdByTabId,
 *   pendingIssueCommandSplitByTabId, pendingSetupSplitByTabId, pendingStartupByTabId
 * Pty-keyed (evicted via the doomed-pty set derived from live and durable bindings):
 *   codexRestartNoticeByPtyId, migrationUnsupportedByPtyId,
 *   suppressedPtyExitIds, pendingCodexPaneRestartIds
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as RuntimeTerminalStreamModule from '@/runtime/runtime-terminal-stream'

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

vi.mock('@/runtime/runtime-terminal-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeTerminalStreamModule>()
  return { ...actual, parseRemoteRuntimePtyId: vi.fn(actual.parseRemoteRuntimePtyId) }
})

const mockApi = {
  worktrees: { list: vi.fn().mockResolvedValue([]), remove: vi.fn().mockResolvedValue(undefined) },
  pty: { kill: vi.fn().mockResolvedValue(undefined) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore, makeWorktree, makeTab } from './store-test-helpers'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'

const WT1 = 'repo1::/path/wt1'
const WT2 = 'repo1::/path/wt2'
const TAB1 = 'tab-wt1'
const TAB2 = 'tab-wt2'
const PTY1 = 'pty-wt1'
const PTY1_SPLIT = 'pty-wt1-split'
const REMOTE_PTY1 = 'remote:env-1@@terminal-wt1'
const REMOTE_HANDLE1 = 'terminal-wt1'
const REMOTE_PTY2_SAME_HANDLE = 'remote:env-2@@terminal-wt1'
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
    // A slept/stale tab has already left the live index, so purge must recover
    // its owned PTY ids from the durable tab/layout wake hints instead.
    ptyIdsByTabId: { [TAB1]: [], [TAB2]: [PTY2] },
    terminalLayoutsByTabId: {
      [TAB1]: {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: 'leaf-1' },
          second: { type: 'leaf', leafId: 'leaf-2' }
        },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': PTY1_SPLIT, 'leaf-2': REMOTE_PTY1 }
      }
    },
    lastKnownRelayPtyIdByTabId: { [TAB1]: PTY1, [TAB2]: PTY2 },
    pendingReconnectPtyIdByTabId: { [TAB1]: PTY1, [TAB2]: PTY2 },
    deferredSshSessionIdsByTabId: { [TAB1]: 'ssh-sess-1', [TAB2]: 'ssh-sess-2' },
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
    },
    suppressedPtyExitIds: {
      [PTY1]: true,
      [PTY1_SPLIT]: true,
      [REMOTE_PTY1]: true,
      [PTY2]: true
    },
    pendingCodexPaneRestartIds: {
      [PTY1]: true,
      [PTY1_SPLIT]: true,
      [REMOTE_PTY1]: true,
      [PTY2]: true
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
    expect(s.pendingReconnectPtyIdByTabId[TAB1]).toBeUndefined()
    expect(s.deferredSshSessionIdsByTabId[TAB1]).toBeUndefined()
    expect(s.pendingInitialCwdByTabId[TAB1]).toBeUndefined()
    expect(s.pendingIssueCommandSplitByTabId[TAB1]).toBeUndefined()
    expect(s.pendingSetupSplitByTabId[TAB1]).toBeUndefined()
    expect(s.pendingStartupByTabId[TAB1]).toBeUndefined()
    expect(s.codexRestartNoticeByPtyId[PTY1]).toBeUndefined()
    expect(s.migrationUnsupportedByPtyId[PTY1]).toBeUndefined()
    expect(s.suppressedPtyExitIds[PTY1]).toBeUndefined()
    expect(s.suppressedPtyExitIds[PTY1_SPLIT]).toBeUndefined()
    expect(s.suppressedPtyExitIds[REMOTE_PTY1]).toBeUndefined()
    expect(s.pendingCodexPaneRestartIds[PTY1]).toBeUndefined()
    expect(s.pendingCodexPaneRestartIds[PTY1_SPLIT]).toBeUndefined()
    expect(s.pendingCodexPaneRestartIds[REMOTE_PTY1]).toBeUndefined()

    // Surviving worktree's tab/pty: every entry retained (no over-eviction).
    expect(s.lastKnownRelayPtyIdByTabId[TAB2]).toBe(PTY2)
    expect(s.pendingReconnectPtyIdByTabId[TAB2]).toBe(PTY2)
    expect(s.deferredSshSessionIdsByTabId[TAB2]).toBe('ssh-sess-2')
    expect(s.pendingInitialCwdByTabId[TAB2]).toBe('/path/wt2')
    expect(s.pendingIssueCommandSplitByTabId[TAB2]).toEqual({ command: 'b' })
    expect(s.pendingSetupSplitByTabId[TAB2]).toEqual({ command: 'setup-b', direction: 'vertical' })
    expect(s.pendingStartupByTabId[TAB2]).toEqual({ command: 'start-b' })
    expect(s.codexRestartNoticeByPtyId[PTY2]).toBeDefined()
    expect(s.migrationUnsupportedByPtyId[PTY2]).toBeDefined()
    expect(s.suppressedPtyExitIds[PTY2]).toBe(true)
    expect(s.pendingCodexPaneRestartIds[PTY2]).toBe(true)
  })

  it('keeps environment-scoped remote guard identities independent', () => {
    const store = createTestStore()
    seedMaps(store)
    store.setState((s) => ({
      ptyIdsByTabId: {
        ...s.ptyIdsByTabId,
        [TAB2]: [...s.ptyIdsByTabId[TAB2], REMOTE_PTY2_SAME_HANDLE]
      },
      suppressedPtyExitIds: {
        ...s.suppressedPtyExitIds,
        [REMOTE_PTY2_SAME_HANDLE]: true
      },
      pendingCodexPaneRestartIds: {
        ...s.pendingCodexPaneRestartIds,
        [REMOTE_PTY2_SAME_HANDLE]: true
      }
    }))

    store.getState().purgeWorktreeTerminalState([WT1])
    const s = store.getState()

    expect(s.suppressedPtyExitIds[REMOTE_PTY1]).toBeUndefined()
    expect(s.pendingCodexPaneRestartIds[REMOTE_PTY1]).toBeUndefined()
    expect(s.suppressedPtyExitIds[REMOTE_PTY2_SAME_HANDLE]).toBe(true)
    expect(s.pendingCodexPaneRestartIds[REMOTE_PTY2_SAME_HANDLE]).toBe(true)
  })

  it('retains a raw remote handle that is also a surviving local PTY id', () => {
    const store = createTestStore()
    seedMaps(store)
    store.setState((s) => ({
      ptyIdsByTabId: {
        ...s.ptyIdsByTabId,
        [TAB2]: [...s.ptyIdsByTabId[TAB2], REMOTE_HANDLE1]
      },
      pendingCodexPaneRestartIds: {
        ...s.pendingCodexPaneRestartIds,
        [REMOTE_HANDLE1]: true
      },
      suppressedPtyExitIds: {
        ...s.suppressedPtyExitIds,
        [REMOTE_HANDLE1]: true
      }
    }))

    store.getState().purgeWorktreeTerminalState([WT1])
    const s = store.getState()

    expect(s.suppressedPtyExitIds[REMOTE_PTY1]).toBeUndefined()
    expect(s.pendingCodexPaneRestartIds[REMOTE_PTY1]).toBeUndefined()
    expect(s.suppressedPtyExitIds[REMOTE_HANDLE1]).toBe(true)
    expect(s.pendingCodexPaneRestartIds[REMOTE_HANDLE1]).toBe(true)
  })

  it('does not parse aliases for environment-scoped remote guard cleanup', () => {
    const store = createTestStore()
    seedMaps(store)
    const parseRemotePtyId = vi.mocked(parseRemoteRuntimePtyId)
    parseRemotePtyId.mockClear()

    store.getState().purgeWorktreeTerminalState([WT1])

    // Why: guard keys stay scoped to their environment, so purge can delete
    // exact identities without parsing aliases or scanning surviving terminals.
    expect(parseRemotePtyId).not.toHaveBeenCalled()
  })
})
