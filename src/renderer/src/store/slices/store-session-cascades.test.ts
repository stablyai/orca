/* eslint-disable max-lines */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type {
  BrowserTab,
  TerminalLayoutSnapshot,
  TerminalTab,
  Worktree
} from '../../../../shared/types'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', () => ({
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

// Mock window.api before anything uses it
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

// @ts-expect-error -- mock
globalThis.window = { api: mockApi }

import { createRepoSlice } from './repos'
import { createWorktreeSlice } from './worktrees'
import { createTerminalSlice } from './terminals'
import { createTabsSlice } from './tabs'
import { createUISlice } from './ui'
import { createSettingsSlice } from './settings'
import { createGitHubSlice } from './github'
import { createLinearSlice } from './linear'
import { createEditorSlice } from './editor'
import { createStatsSlice } from './stats'
import { createClaudeUsageSlice } from './claude-usage'
import { createCodexUsageSlice } from './codex-usage'
import { createBrowserSlice } from './browser'
import { createRateLimitSlice } from './rate-limits'
import { createSshSlice } from './ssh'
import { createAgentStatusSlice } from './agent-status'
import { createDiffCommentsSlice } from './diffComments'
import { createDetectedAgentsSlice } from './detected-agents'
import { createWorktreeNavHistorySlice } from './worktree-nav-history'

function createTestStore() {
  return create<AppState>()((...a) => ({
    ...createRepoSlice(...a),
    ...createWorktreeSlice(...a),
    ...createTerminalSlice(...a),
    ...createTabsSlice(...a),
    ...createUISlice(...a),
    ...createSettingsSlice(...a),
    ...createGitHubSlice(...a),
    ...createLinearSlice(...a),
    ...createEditorSlice(...a),
    ...createStatsSlice(...a),
    ...createClaudeUsageSlice(...a),
    ...createCodexUsageSlice(...a),
    ...createBrowserSlice(...a),
    ...createRateLimitSlice(...a),
    ...createSshSlice(...a),
    ...createAgentStatusSlice(...a),
    ...createDiffCommentsSlice(...a),
    ...createDetectedAgentsSlice(...a),
    ...createWorktreeNavHistorySlice(...a)
  }))
}

// ─── Helpers ──────────────────────────────────────────────────────────

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: '/tmp/wt',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeTab(
  overrides: Partial<TerminalTab> & { id: string; worktreeId: string }
): TerminalTab {
  return {
    ptyId: null,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: Date.now(),
    ...overrides
  }
}

function makeLayout(): TerminalLayoutSnapshot {
  return { root: null, activeLeafId: null, expandedLeafId: null }
}

function makeBrowserTab(
  overrides: Partial<BrowserTab> & { id: string; worktreeId: string; url: string }
): BrowserTab {
  return {
    title: overrides.url,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: Date.now(),
    ...overrides
  }
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('removeRepo cascade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.repos.remove.mockResolvedValue(undefined)
    mockApi.pty.kill.mockResolvedValue(undefined)
  })

  it('cleans up all associated worktrees, tabs, ptys, and filter state', async () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'
    const wt2 = 'repo1::/path/wt2'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      activeRepoId: 'repo1',
      filterRepoIds: ['repo1'],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: {
        [wt1]: [makeTab({ id: 'tab1', worktreeId: wt1 })],
        [wt2]: [makeTab({ id: 'tab2', worktreeId: wt2 })]
      },
      ptyIdsByTabId: {
        tab1: ['pty1'],
        tab2: ['pty2']
      },
      terminalLayoutsByTabId: {
        tab1: makeLayout(),
        tab2: makeLayout()
      },
      activeTabId: 'tab1'
    })

    await store.getState().removeRepo('repo1')
    const s = store.getState()

    expect(s.repos).toEqual([])
    expect(s.activeRepoId).toBeNull()
    expect(s.filterRepoIds).not.toContain('repo1')
    expect(s.worktreesByRepo['repo1']).toBeUndefined()
    expect(s.tabsByWorktree[wt1]).toBeUndefined()
    expect(s.tabsByWorktree[wt2]).toBeUndefined()
    expect(s.ptyIdsByTabId['tab1']).toBeUndefined()
    expect(s.ptyIdsByTabId['tab2']).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab1']).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab2']).toBeUndefined()
    expect(s.activeTabId).toBeNull()

    // PTYs were killed
    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty1')
    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty2')

    // Killed PTY IDs are suppressed
    expect(s.suppressedPtyExitIds['pty1']).toBe(true)
    expect(s.suppressedPtyExitIds['pty2']).toBe(true)
  })
})

describe('restartCodexTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queues pane-scoped codex restarts without remounting the whole tab', () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt1]: [makeTab({ id: 'tab1', worktreeId: wt1, title: 'codex', generation: 2 })]
      },
      ptyIdsByTabId: {
        tab1: ['pty-a', 'pty-b']
      },
      pendingStartupByTabId: {}
    })

    store.getState().queueCodexPaneRestarts(['pty-b'])
    const state = store.getState()

    expect(state.pendingCodexPaneRestartIds).toEqual({ 'pty-b': true })
    expect(state.pendingStartupByTabId).toEqual({})
    expect(state.suppressedPtyExitIds).toEqual({})
    expect(state.tabsByWorktree[wt1][0].generation).toBe(2)
  })
})

describe('hydrateWorkspaceSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('filters out tabs for invalid worktree IDs', () => {
    const store = createTestStore()
    const validWt = 'repo1::/path/wt1'
    const invalidWt = 'repo1::/path/gone'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: validWt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: invalidWt,
      activeTabId: 'tab-invalid',
      tabsByWorktree: {
        [validWt]: [makeTab({ id: 'tab-valid', worktreeId: validWt })],
        [invalidWt]: [makeTab({ id: 'tab-invalid', worktreeId: invalidWt })]
      },
      terminalLayoutsByTabId: {
        'tab-valid': makeLayout(),
        'tab-invalid': makeLayout()
      }
    })

    const s = store.getState()

    // Valid worktree tabs restored
    expect(s.tabsByWorktree[validWt]).toHaveLength(1)
    expect(s.tabsByWorktree[validWt][0].id).toBe('tab-valid')

    // Invalid worktree tabs dropped
    expect(s.tabsByWorktree[invalidWt]).toBeUndefined()

    // activeWorktreeId is null because it referenced an invalid worktree
    expect(s.activeWorktreeId).toBeNull()

    // activeTabId is null because it referenced an invalid tab
    expect(s.activeTabId).toBeNull()

    // Terminal layouts only contain valid tabs
    expect(s.terminalLayoutsByTabId['tab-valid']).toBeDefined()
    expect(s.terminalLayoutsByTabId['tab-invalid']).toBeUndefined()

    // Why: with two-phase hydration, workspaceSessionReady stays false after
    // hydrateWorkspaceSession. It flips to true in reconnectPersistedTerminals()
    // after all eager PTY spawns complete.
    expect(s.workspaceSessionReady).toBe(false)
  })

  it('restores valid activeWorktreeId and activeTabId', () => {
    const store = createTestStore()
    const validWt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: validWt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: validWt,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [validWt]: [makeTab({ id: 'tab1', worktreeId: validWt })]
      },
      terminalLayoutsByTabId: {
        tab1: makeLayout()
      }
    })

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(validWt)
    expect(s.activeTabId).toBe('tab1')
    expect(s.activeRepoId).toBe('repo1')
  })
})

describe('hydrateBrowserSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to the first valid browser tab when the persisted active browser tab is missing', () => {
    const store = createTestStore()
    const validWt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: validWt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: validWt
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: validWt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [validWt]: [
          makeBrowserTab({ id: 'browser-1', worktreeId: validWt, url: 'https://example.com' }),
          makeBrowserTab({ id: 'browser-2', worktreeId: validWt, url: 'https://openai.com' })
        ]
      },
      activeBrowserTabIdByWorktree: {
        [validWt]: 'missing-browser-id'
      },
      activeTabTypeByWorktree: {
        [validWt]: 'browser'
      }
    })

    const s = store.getState()
    expect(s.browserTabsByWorktree[validWt]).toHaveLength(2)
    expect(s.activeBrowserTabIdByWorktree[validWt]).toBe('browser-1')
    expect(s.activeBrowserTabId).toBe('browser-1')
  })

  it('restores activeTabTypeByWorktree for browser worktrees when hydrateEditorSession was a no-op', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      // Simulate hydrateEditorSession returning {} (no editor files) —
      // activeTabTypeByWorktree stays at the initial empty object
      activeTabTypeByWorktree: {}
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [wt]: [makeBrowserTab({ id: 'browser-1', worktreeId: wt, url: 'https://example.com' })]
      },
      activeBrowserTabIdByWorktree: { [wt]: 'browser-1' },
      activeTabTypeByWorktree: { [wt]: 'browser' }
    })

    const s = store.getState()
    // hydrateBrowserSession must merge 'browser' entries into activeTabTypeByWorktree
    // so setActiveWorktree doesn't default to 'terminal' and cause a blank screen
    expect(s.activeTabTypeByWorktree[wt]).toBe('browser')
    expect(s.activeTabType).toBe('browser')
    expect(s.activeBrowserTabId).toBe('browser-1')
  })

  it('does not overwrite existing activeTabTypeByWorktree entries from hydrateEditorSession', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      // Simulate hydrateEditorSession having already set this to 'editor'
      activeTabTypeByWorktree: { [wt]: 'editor' }
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [wt]: [makeBrowserTab({ id: 'browser-1', worktreeId: wt, url: 'https://example.com' })]
      },
      activeBrowserTabIdByWorktree: { [wt]: 'browser-1' },
      activeTabTypeByWorktree: { [wt]: 'browser' }
    })

    const s = store.getState()
    // The existing 'editor' entry set by hydrateEditorSession must not be overwritten
    expect(s.activeTabTypeByWorktree[wt]).toBe('editor')
  })

  it('drops browser tabs for invalid worktrees', () => {
    const store = createTestStore()
    const validWt = 'repo1::/path/wt1'
    const invalidWt = 'repo1::/path/gone'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: validWt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: validWt
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: validWt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [validWt]: [
          makeBrowserTab({ id: 'browser-1', worktreeId: validWt, url: 'https://example.com' })
        ],
        [invalidWt]: [
          makeBrowserTab({ id: 'browser-bad', worktreeId: invalidWt, url: 'https://bad.invalid' })
        ]
      },
      activeBrowserTabIdByWorktree: {
        [validWt]: 'browser-1',
        [invalidWt]: 'browser-bad'
      }
    })

    const s = store.getState()
    expect(s.browserTabsByWorktree[validWt]).toHaveLength(1)
    expect(s.browserTabsByWorktree[invalidWt]).toBeUndefined()
    expect(s.activeBrowserTabIdByWorktree[invalidWt]).toBeUndefined()
  })

  it('normalizes stale browser tab-type restores when the worktree has no browser tabs', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      activeTabType: 'browser'
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: 'terminal-1',
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'terminal-1', worktreeId: wt })]
      },
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      activeTabTypeByWorktree: { [wt]: 'browser' }
    })

    const s = store.getState()
    expect(s.activeTabTypeByWorktree[wt]).toBe('terminal')
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeBrowserTabIdByWorktree[wt]).toBeUndefined()
    expect(s.activeBrowserTabId).toBeNull()
  })
})

describe('terminal slice behaviors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves tabs omitted from a reorder request instead of dropping them', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({ id: 'tab-a', worktreeId, sortOrder: 0, createdAt: 1 }),
          makeTab({ id: 'tab-b', worktreeId, sortOrder: 1, createdAt: 2 }),
          makeTab({ id: 'tab-c', worktreeId, sortOrder: 2, createdAt: 3 })
        ]
      }
    })

    store.getState().reorderTabs(worktreeId, ['tab-c', 'tab-a'])

    expect(store.getState().tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: 'tab-c', sortOrder: 0 }),
      expect.objectContaining({ id: 'tab-a', sortOrder: 1 }),
      expect.objectContaining({ id: 'tab-b', sortOrder: 2 })
    ])
  })

  it('falls back to the previous PTY id when clearing the active pane PTY', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'pty-2' })]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1', 'pty-2']
      }
    })

    store.getState().clearTabPtyId('tab-1', 'pty-2')

    const tab = store.getState().tabsByWorktree[worktreeId][0]
    expect(tab.ptyId).toBe('pty-1')
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(['pty-1'])
  })

  it('keeps the original tab-level PTY when a split pane adds another PTY', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      }
    })

    store.getState().updateTabPtyId('tab-1', 'pty-2')

    const tab = store.getState().tabsByWorktree[worktreeId][0]
    expect(tab.ptyId).toBe('pty-1')
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(['pty-1', 'pty-2'])
  })
})

// ─── Reconnect persisted terminals ──────────────────────────────────

// Mock pty-transport's eager buffer registration
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn().mockReturnValue({ flush: () => '', dispose: () => {} }),
  ensurePtyDispatcher: vi.fn()
}))

describe('reconnectPersistedTerminals', () => {
  let ptyIdCounter: number

  // Why: reconnect-by-daemon-session-ID is an opt-in path (the experimental
  // daemon toggle). These tests exercise that path, so each store created here
  // must have the toggle set to true before hydrateWorkspaceSession runs —
  // otherwise hydration clears pendingReconnectPtyIdByTabId and tab.ptyId
  // never gets rehydrated.
  function createDaemonEnabledStore(): ReturnType<typeof createTestStore> {
    const store = createTestStore()
    store.setState((prev) => ({
      settings: {
        ...(prev.settings ?? ({} as AppState['settings'])),
        experimentalTerminalDaemon: true
      } as AppState['settings']
    }))
    return store
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ptyIdCounter = 0
    // Mock pty.spawn to return incrementing IDs
    mockApi.pty.kill = vi.fn().mockResolvedValue(undefined)
    ;(mockApi.pty as Record<string, unknown>).spawn = vi.fn().mockImplementation(() => {
      ptyIdCounter++
      return Promise.resolve({ id: `pty-${ptyIdCounter}` })
    })
  })

  it('records daemon session IDs for deferred reattach and sets workspaceSessionReady', async () => {
    const store = createDaemonEnabledStore()
    const wt1 = 'repo1::/path/wt1'
    const wt2 = 'repo1::/path/wt2'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/path/wt2' })
        ]
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt1,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [wt1]: [makeTab({ id: 'tab1', worktreeId: wt1, ptyId: 'old-pty-1' })],
        [wt2]: [makeTab({ id: 'tab2', worktreeId: wt2, ptyId: 'old-pty-2' })]
      },
      terminalLayoutsByTabId: { tab1: makeLayout(), tab2: makeLayout() },
      activeWorktreeIdsOnShutdown: [wt1, wt2]
    })

    expect(store.getState().workspaceSessionReady).toBe(false)
    expect(store.getState().tabsByWorktree[wt1][0].ptyId).toBeNull()
    expect(store.getState().tabsByWorktree[wt2][0].ptyId).toBeNull()
    expect(store.getState().pendingReconnectWorktreeIds).toEqual([wt1, wt2])

    await store.getState().reconnectPersistedTerminals()

    const s = store.getState()
    expect(s.workspaceSessionReady).toBe(true)
    // Why: Option 2 defers actual pty.spawn to connectPanePty. The store
    // records daemon session IDs as tab-level ptyIds so connectPanePty
    // can pass them as sessionId to the daemon's createOrAttach.
    expect(s.tabsByWorktree[wt1][0].ptyId).toBe('old-pty-1')
    expect(s.tabsByWorktree[wt2][0].ptyId).toBe('old-pty-2')
    expect(s.pendingReconnectWorktreeIds).toEqual([])
    // No eager spawn — PTY creation deferred to pane mount
    expect((mockApi.pty as Record<string, unknown>).spawn).not.toHaveBeenCalled()
  })

  it('does not restore old pty ids onto remote tabs during reconnect preparation', async () => {
    const store = createTestStore()
    const wt1 = 'repo1::/remote/wt1'

    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt1, repoId: 'repo1', path: '/remote/wt1' })]
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt1,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [wt1]: [makeTab({ id: 'tab1', worktreeId: wt1, ptyId: 'old-remote-pty' })]
      },
      terminalLayoutsByTabId: { tab1: makeLayout() },
      activeWorktreeIdsOnShutdown: [wt1]
    })

    await store.getState().reconnectPersistedTerminals()

    const s = store.getState()
    expect(s.tabsByWorktree[wt1][0].ptyId).toBeNull()
    expect(s.ptyIdsByTabId.tab1).toEqual([])
  })

  it('sets workspaceSessionReady even with no pending worktrees', async () => {
    const store = createTestStore()

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [] }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    })

    await store.getState().reconnectPersistedTerminals()
    expect(store.getState().workspaceSessionReady).toBe(true)
    expect((mockApi.pty as Record<string, unknown>).spawn).not.toHaveBeenCalled()
  })

  it('falls back to tab ptyIds when activeWorktreeIdsOnShutdown is absent (upgrade)', async () => {
    const store = createDaemonEnabledStore()
    const wt1 = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    // No activeWorktreeIdsOnShutdown — simulates session from older build
    // The tab still has a ptyId from the raw session data
    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt1,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [wt1]: [makeTab({ id: 'tab1', worktreeId: wt1, ptyId: 'old-pty' })]
      },
      terminalLayoutsByTabId: { tab1: makeLayout() }
      // No activeWorktreeIdsOnShutdown field
    })

    expect(store.getState().pendingReconnectWorktreeIds).toEqual([wt1])

    await store.getState().reconnectPersistedTerminals()
    // Why: deferred reattach records the old daemon session ID on the tab
    expect(store.getState().tabsByWorktree[wt1][0].ptyId).toBe('old-pty')
  })

  it('reconnects the correct tab per worktree (not always tabs[0])', async () => {
    const store = createDaemonEnabledStore()
    const wt1 = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    // Tab2 had the live PTY, not tab1
    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt1,
      activeTabId: 'tab2',
      tabsByWorktree: {
        [wt1]: [
          makeTab({ id: 'tab1', worktreeId: wt1, ptyId: null }),
          makeTab({ id: 'tab2', worktreeId: wt1, ptyId: 'old-pty-2' })
        ]
      },
      terminalLayoutsByTabId: { tab1: makeLayout(), tab2: makeLayout() },
      activeWorktreeIdsOnShutdown: [wt1]
    })

    await store.getState().reconnectPersistedTerminals()

    // tab2 should get its daemon session ID, not tab1
    expect(store.getState().tabsByWorktree[wt1][0].ptyId).toBeNull() // tab1 had no ptyId
    expect(store.getState().tabsByWorktree[wt1][1].ptyId).toBe('old-pty-2') // tab2
  })

  it('reconnects multiple live tabs in the same worktree', async () => {
    const store = createDaemonEnabledStore()
    const wt1 = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    // Both tabs had live PTYs
    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt1,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [wt1]: [
          makeTab({ id: 'tab1', worktreeId: wt1, ptyId: 'old-pty-1' }),
          makeTab({ id: 'tab2', worktreeId: wt1, ptyId: 'old-pty-2' })
        ]
      },
      terminalLayoutsByTabId: { tab1: makeLayout(), tab2: makeLayout() },
      activeWorktreeIdsOnShutdown: [wt1]
    })

    await store.getState().reconnectPersistedTerminals()

    // Both tabs should have their daemon session IDs recorded
    expect(store.getState().tabsByWorktree[wt1][0].ptyId).toBe('old-pty-1')
    expect(store.getState().tabsByWorktree[wt1][1].ptyId).toBe('old-pty-2')
  })

  it('does not bump lastActivityAt for reconnected worktrees', async () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1', lastActivityAt: 1000 })]
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt1,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [wt1]: [makeTab({ id: 'tab1', worktreeId: wt1, ptyId: 'old-pty' })]
      },
      terminalLayoutsByTabId: { tab1: makeLayout() },
      activeWorktreeIdsOnShutdown: [wt1]
    })

    await store.getState().reconnectPersistedTerminals()

    // updateMeta should NOT have been called — we bypassed bumpWorktreeActivity
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('skips deleted worktrees in activeWorktreeIdsOnShutdown', async () => {
    const store = createDaemonEnabledStore()
    const existing = 'repo1::/path/wt1'
    const deleted = 'repo1::/path/deleted'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: existing, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: existing,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [existing]: [makeTab({ id: 'tab1', worktreeId: existing, ptyId: 'old' })]
      },
      terminalLayoutsByTabId: { tab1: makeLayout() },
      activeWorktreeIdsOnShutdown: [existing, deleted]
    })

    // Deleted worktree should be filtered out
    expect(store.getState().pendingReconnectWorktreeIds).toEqual([existing])

    await store.getState().reconnectPersistedTerminals()
    // Why: deferred reattach doesn't call spawn — just records session IDs
    expect((mockApi.pty as Record<string, unknown>).spawn).not.toHaveBeenCalled()
    // The existing worktree's tab should have its daemon session ID
    expect(store.getState().tabsByWorktree[existing][0].ptyId).toBe('old')
  })

  it('preserves split-pane ptyIdsByLeafId for deferred reattach by connectPanePty', async () => {
    const store = createDaemonEnabledStore()
    const wt1 = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    // Why: split-pane tab has two leaves, each with its own daemon session.
    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt1,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [wt1]: [makeTab({ id: 'tab1', worktreeId: wt1, ptyId: 'daemon-session-B' })]
      },
      terminalLayoutsByTabId: {
        tab1: {
          ...makeLayout(),
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: 'pane:1' },
            second: { type: 'leaf', leafId: 'pane:3' }
          },
          ptyIdsByLeafId: { 'pane:1': 'daemon-session-A', 'pane:3': 'daemon-session-B' }
        }
      },
      activeWorktreeIdsOnShutdown: [wt1]
    })

    await store.getState().reconnectPersistedTerminals()

    const s = store.getState()
    // Why: deferred reattach doesn't call spawn — connectPanePty handles it
    expect((mockApi.pty as Record<string, unknown>).spawn).not.toHaveBeenCalled()
    // Why: reconnect restores the tab-level ptyId so getWorktreeStatus()
    // sees the tab as active (green dot) even before the terminal mounts.
    // connectPanePty reads ptyIdsByLeafId for per-leaf daemon sessions.
    expect(s.tabsByWorktree[wt1][0].ptyId).toBe('daemon-session-B')
    // ptyIdsByLeafId preserved from hydration for connectPanePty to consume
    const layout = s.terminalLayoutsByTabId['tab1']
    expect(layout.ptyIdsByLeafId).toEqual({
      'pane:1': 'daemon-session-A',
      'pane:3': 'daemon-session-B'
    })
    expect(s.workspaceSessionReady).toBe(true)
  })
})

describe('hydrateEditorSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('restores edit-mode files from persisted session', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      // Why: hydrateEditorSession reads activeWorktreeId from the store
      // (set by hydrateWorkspaceSession), not from the raw session.
      activeWorktreeId: wt
    })

    store.getState().hydrateEditorSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [wt]: [
          {
            filePath: '/path/wt1/src/index.ts',
            relativePath: 'src/index.ts',
            worktreeId: wt,
            language: 'typescript'
          },
          {
            filePath: '/path/wt1/README.md',
            relativePath: 'README.md',
            worktreeId: wt,
            language: 'markdown',
            isPreview: true
          }
        ]
      },
      activeFileIdByWorktree: { [wt]: '/path/wt1/src/index.ts' },
      activeTabTypeByWorktree: { [wt]: 'editor' }
    })

    const s = store.getState()
    expect(s.openFiles).toHaveLength(2)
    expect(s.openFiles[0].filePath).toBe('/path/wt1/src/index.ts')
    expect(s.openFiles[0].mode).toBe('edit')
    expect(s.openFiles[0].isDirty).toBe(false)
    expect(s.openFiles[1].isPreview).toBe(true)
    expect(s.activeFileId).toBe('/path/wt1/src/index.ts')
    expect(s.activeTabType).toBe('editor')
  })

  it('does nothing when no editor files are persisted', () => {
    const store = createTestStore()

    store.getState().hydrateEditorSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    })

    const s = store.getState()
    expect(s.openFiles).toHaveLength(0)
    expect(s.activeFileId).toBeNull()
    expect(s.activeTabType).toBe('terminal')
  })

  it('clears stale editor markers when no edit-mode files restore for the active worktree', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'editor'
    })

    store.getState().hydrateEditorSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      activeFileIdByWorktree: { [wt]: `${wt}::diff::unstaged::src/index.ts` },
      activeTabTypeByWorktree: { [wt]: 'editor' }
    })

    const s = store.getState()
    expect(s.openFiles).toHaveLength(0)
    expect(s.activeFileId).toBeNull()
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeFileIdByWorktree[wt]).toBeUndefined()
    expect(s.activeTabTypeByWorktree[wt]).toBeUndefined()
  })

  it('promotes the first restored edit file if persisted activeFileId is missing', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })

    store.getState().hydrateEditorSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [wt]: [
          {
            filePath: '/path/wt1/src/index.ts',
            relativePath: 'src/index.ts',
            worktreeId: wt,
            language: 'typescript'
          }
        ]
      },
      // Points to a file that no longer exists in the restored set
      activeFileIdByWorktree: { [wt]: '/path/wt1/gone.ts' },
      activeTabTypeByWorktree: { [wt]: 'editor' }
    })

    const s = store.getState()
    expect(s.openFiles).toHaveLength(1)
    expect(s.activeFileId).toBe('/path/wt1/src/index.ts')
    expect(s.activeTabType).toBe('editor')
    expect(s.activeFileIdByWorktree[wt]).toBe('/path/wt1/src/index.ts')
    expect(s.activeTabTypeByWorktree[wt]).toBe('editor')
  })

  it('filters out files for deleted worktrees', () => {
    const store = createTestStore()
    const validWt = 'repo1::/path/wt1'
    const deletedWt = 'repo1::/path/gone'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: validWt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: validWt
    })

    store.getState().hydrateEditorSession({
      activeRepoId: 'repo1',
      activeWorktreeId: validWt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [validWt]: [
          {
            filePath: '/path/wt1/src/index.ts',
            relativePath: 'src/index.ts',
            worktreeId: validWt,
            language: 'typescript'
          }
        ],
        [deletedWt]: [
          {
            filePath: '/path/gone/src/app.ts',
            relativePath: 'src/app.ts',
            worktreeId: deletedWt,
            language: 'typescript'
          }
        ]
      },
      activeFileIdByWorktree: {
        [validWt]: '/path/wt1/src/index.ts',
        [deletedWt]: '/path/gone/src/app.ts'
      },
      activeTabTypeByWorktree: { [validWt]: 'editor', [deletedWt]: 'editor' }
    })

    const s = store.getState()
    // Only files from the valid worktree should be restored
    expect(s.openFiles).toHaveLength(1)
    expect(s.openFiles[0].worktreeId).toBe(validWt)
    // Deleted worktree should not appear in per-worktree maps
    expect(s.activeFileIdByWorktree[deletedWt]).toBeUndefined()
    expect(s.activeTabTypeByWorktree[deletedWt]).toBeUndefined()
  })
})
