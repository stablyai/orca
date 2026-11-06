import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

const mockApi = {
  worktrees: {
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  repos: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({}),
    pickFolder: vi.fn().mockResolvedValue(null)
  },
  pty: {
    kill: vi.fn().mockResolvedValue(undefined)
  },
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    issue: vi.fn().mockResolvedValue(null)
  },
  settings: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined)
  },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  },
  claudeUsage: {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyClaudeData: false
    }),
    setEnabled: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue({}),
    getSummary: vi.fn().mockResolvedValue(null),
    getDaily: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
    getRecentSessions: vi.fn().mockResolvedValue([])
  },
  codexUsage: {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyCodexData: false
    }),
    setEnabled: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue({}),
    getSummary: vi.fn().mockResolvedValue(null),
    getDaily: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
    getRecentSessions: vi.fn().mockResolvedValue([])
  },
  openCodeUsage: {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyOpenCodeData: false
    }),
    setEnabled: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue({}),
    getSummary: vi.fn().mockResolvedValue(null),
    getDaily: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
    getRecentSessions: vi.fn().mockResolvedValue([])
  }
}

// @ts-expect-error -- mocked browser preload API
globalThis.window = { api: mockApi }

import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import '../../../../shared/constants'
import '../../../../shared/workspace-scope'
import { createTestStore, makeLayout, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { canGoBackWorktreeHistory } from './worktree-nav-history'

describe('hydrateWorkspaceSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('batches restored terminal reconnect wake hints into one store update', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/wt-1'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/wt-1' })]
      }
    })
    const session: WorkspaceSessionState = {
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabId: 'tab-1',
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({ id: 'tab-1', worktreeId, ptyId: 'pty-1' }),
          makeTab({ id: 'tab-2', worktreeId, ptyId: 'pty-2' }),
          makeTab({ id: 'tab-3', worktreeId, ptyId: 'pty-3' })
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': makeLayout(),
        'tab-2': makeLayout(),
        'tab-3': makeLayout()
      },
      activeWorktreeIdsOnShutdown: [worktreeId]
    }

    store.getState().hydrateWorkspaceSession(session)

    let updateCount = 0
    const unsubscribe = store.subscribe(() => {
      updateCount += 1
    })
    await store.getState().reconnectPersistedTerminals()
    unsubscribe()

    // Why: startup restores every daemon wake hint, but subscribers should see one ready-state transition, not one update per restored tab.
    expect(updateCount).toBe(1)
    expect(store.getState().workspaceSessionReady).toBe(true)
    expect(store.getState().ptyIdsByTabId).toMatchObject({
      'tab-1': ['pty-1'],
      'tab-2': ['pty-2'],
      'tab-3': ['pty-3']
    })
    expect(store.getState().tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: 'tab-1', ptyId: 'pty-1' }),
      expect.objectContaining({ id: 'tab-2', ptyId: 'pty-2' }),
      expect.objectContaining({ id: 'tab-3', ptyId: 'pty-3' })
    ])
  })

  it('records a subsequent visit on top of the hydration seed so Back is enabled after the first click', () => {
    // Restored history[0] enables Back on the first sidebar click.
    const store = createTestStore()
    const wt1 = 'repo1::/wt-1'
    const wt2 = 'repo1::/wt-2'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/wt-1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/wt-2' })
        ]
      }
    })

    const session: WorkspaceSessionState = {
      activeRepoId: 'repo1',
      activeWorktreeId: wt1,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }

    store.getState().hydrateWorkspaceSession(session)
    store.getState().recordWorktreeVisit(wt2)

    expect(store.getState().worktreeNavHistory).toEqual([wt1, wt2])
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)
    expect(canGoBackWorktreeHistory(store.getState())).toBe(true)
  })
})
