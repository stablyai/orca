/** Bulk purge runs no terminal teardown; evict tab maps and PTY maps from live/durable bindings like single removal. External scans/project removal/hydration otherwise leak ephemeral terminal/agent keys for renderer lifetime. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as RemoteRuntimePtyIdModule from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

vi.mock('../../../../../../shared/remote-runtime/remote-runtime-pty-id', async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteRuntimePtyIdModule>()
  return { ...actual, parseRemoteRuntimePtyId: vi.fn(actual.parseRemoteRuntimePtyId) }
})

const mockApi = {
  worktrees: { remove: vi.fn().mockResolvedValue(undefined) },
  pty: { kill: vi.fn().mockResolvedValue(undefined) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import { makeTab } from '../../../terminals/terminal-tab.test-fixture'
import '../../../../../../shared/remote-runtime/remote-runtime-pty-id'

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
    // Slept/stale tabs lack live PTY index entries; recover owned IDs from durable wake bindings.
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
    pendingPaneAccountRestarts: {
      [PTY1]: 'codex',
      [PTY1_SPLIT]: 'codex',
      [REMOTE_PTY1]: 'codex',
      [PTY2]: 'codex'
    }
  })
}

describe('bulk worktree purge evicts the per-tab/per-pty terminal maps it previously leaked', () => {
  beforeEach(() => vi.clearAllMocks())

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
      pendingPaneAccountRestarts: {
        ...s.pendingPaneAccountRestarts,
        [REMOTE_PTY2_SAME_HANDLE]: 'codex'
      }
    }))

    store.getState().purgeWorktreeTerminalState([WT1])
    const s = store.getState()

    expect(s.suppressedPtyExitIds[REMOTE_PTY1]).toBeUndefined()
    expect(s.pendingPaneAccountRestarts[REMOTE_PTY1]).toBeUndefined()
    expect(s.suppressedPtyExitIds[REMOTE_PTY2_SAME_HANDLE]).toBe(true)
    expect(s.pendingPaneAccountRestarts[REMOTE_PTY2_SAME_HANDLE]).toBe('codex')
  })

  it('retains a raw remote handle that is also a surviving local PTY id', () => {
    const store = createTestStore()
    seedMaps(store)
    store.setState((s) => ({
      ptyIdsByTabId: {
        ...s.ptyIdsByTabId,
        [TAB2]: [...s.ptyIdsByTabId[TAB2], REMOTE_HANDLE1]
      },
      pendingPaneAccountRestarts: {
        ...s.pendingPaneAccountRestarts,
        [REMOTE_HANDLE1]: 'codex'
      },
      suppressedPtyExitIds: {
        ...s.suppressedPtyExitIds,
        [REMOTE_HANDLE1]: true
      }
    }))

    store.getState().purgeWorktreeTerminalState([WT1])
    const s = store.getState()

    expect(s.suppressedPtyExitIds[REMOTE_PTY1]).toBeUndefined()
    expect(s.pendingPaneAccountRestarts[REMOTE_PTY1]).toBeUndefined()
    expect(s.suppressedPtyExitIds[REMOTE_HANDLE1]).toBe(true)
    expect(s.pendingPaneAccountRestarts[REMOTE_HANDLE1]).toBe('codex')
  })
})
