import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', () => ({
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
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
  }
}

// @ts-expect-error -- mocked browser preload API
globalThis.window = { api: mockApi }

import type { WorkspaceSessionState } from '../../../../shared/types'
import { createTestStore, makeLayout, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { canGoBackWorktreeHistory } from './worktree-nav-history'

describe('hydrateWorkspaceSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves ptyIdsByLeafId so reconnect can reattach each split-pane leaf', () => {
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
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'old-pty' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...makeLayout(),
          ptyIdsByLeafId: { 'pane:1': 'daemon-session-1' },
          buffersByLeafId: { 'pane:1': 'buffer' }
        }
      }
    }

    store.getState().hydrateWorkspaceSession(session)

    // Why: ptyIdsByLeafId contains daemon session IDs that survive restart.
    // reconnectPersistedTerminals uses them to reattach each split-pane
    // leaf to its specific daemon session.
    expect(store.getState().terminalLayoutsByTabId['tab-1']).toEqual({
      ...makeLayout(),
      ptyIdsByLeafId: { 'pane:1': 'daemon-session-1' },
      buffersByLeafId: { 'pane:1': 'buffer' }
    })
  })

  it('seeds worktree nav history with the restored active worktree', () => {
    // Why: without seeding, the first sidebar click after startup becomes the
    // only history entry, so Back stays disabled until the user clicks a
    // second worktree. Seeding here ensures the restored worktree is already
    // at index 0 so the very first user-driven switch has a prior entry to
    // go Back to.
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
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }

    store.getState().hydrateWorkspaceSession(session)

    expect(store.getState().worktreeNavHistory).toEqual([worktreeId])
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)
  })

  it('leaves nav history empty when no active worktree is restored', () => {
    const store = createTestStore()
    seedStore(store, { worktreesByRepo: {} })

    // Why: pre-seed non-default stale values so the assertions below can only
    // pass if hydration actively overwrites the fields. Without this, the
    // slice's default `[]` / `-1` would satisfy the expectations even if
    // hydrateWorkspaceSession never touched nav history in this branch.
    store.setState({ worktreeNavHistory: ['stale-a', 'stale-b'], worktreeNavHistoryIndex: 1 })

    const session: WorkspaceSessionState = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }

    store.getState().hydrateWorkspaceSession(session)

    expect(store.getState().worktreeNavHistory).toEqual([])
    expect(store.getState().worktreeNavHistoryIndex).toBe(-1)
  })

  it('drops invalid restored worktree from nav history seed', () => {
    // Why: hydrateWorkspaceSession validates activeWorktreeId against the
    // current worktreesByRepo and sets it to null when stale. The history
    // seed must follow that validation, not the raw session field — otherwise
    // a deleted worktree would sit at history[0] and fail activation on Back.
    const store = createTestStore()
    seedStore(store, { worktreesByRepo: { repo1: [] } })

    // Why: pre-seed non-default stale values so the assertions below can only
    // pass if hydration actively overwrites the fields. Without this, the
    // slice's default `[]` / `-1` would satisfy the expectations even if
    // hydrateWorkspaceSession never cleared nav history for an invalid worktree.
    store.setState({ worktreeNavHistory: ['stale-a', 'stale-b'], worktreeNavHistoryIndex: 1 })

    const session: WorkspaceSessionState = {
      activeRepoId: 'repo1',
      activeWorktreeId: 'repo1::/missing',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    }

    store.getState().hydrateWorkspaceSession(session)

    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().worktreeNavHistory).toEqual([])
    expect(store.getState().worktreeNavHistoryIndex).toBe(-1)
  })

  it('records a subsequent visit on top of the hydration seed so Back is enabled after the first click', () => {
    // Why: pins down the PR's user-visible contract — after hydration seeds
    // the restored worktree at index 0, the very first sidebar click appends
    // a new entry at index 1, which is what makes Back enabled immediately.
    // Without the seed, the first click would produce a single-entry history
    // and Back would stay disabled until a second click.
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
