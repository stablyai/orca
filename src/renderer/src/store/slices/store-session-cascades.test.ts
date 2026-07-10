/* eslint-disable max-lines */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { BrowserTab, DetectedWorktreeListResult, Worktree } from '../../../../shared/types'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  getDefaultWorkspaceSession
} from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

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

// @ts-expect-error -- mock
globalThis.window = { api: mockApi }

import { createTestStore, makeWorktree, makeTab, makeLayout } from './store-test-helpers'
import { computeVisibleWorktreeIds } from '@/components/sidebar/visible-worktrees'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

// ─── Helpers ──────────────────────────────────────────────────────────

function makeDetectedWorktreeResult(
  repoId: string,
  worktrees: Worktree[],
  authoritative = true
): DetectedWorktreeListResult {
  return {
    repoId,
    authoritative,
    source: authoritative ? 'git' : 'metadata-fallback',
    worktrees: worktrees.map((worktree) => ({
      ...worktree,
      ownership: 'orca-managed',
      selectedCheckout: false,
      visible: true
    }))
  }
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

function ownedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeEnvironmentId?.trim() || 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('removeProject cascade', () => {
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

    await store.getState().removeProject('repo1')
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

  it('hydrates quick command labels from unified tabs back to terminal tabs', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: 'tab-1',
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'pnpm test' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': makeLayout()
      },
      unifiedTabs: {
        [wt]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId: wt,
            contentType: 'terminal',
            label: 'pnpm test',
            quickCommandLabel: 'Run tests',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [wt]: [{ id: 'group-1', worktreeId: wt, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      }
    })

    expect(store.getState().tabsByWorktree[wt][0].quickCommandLabel).toBe('Run tests')
  })

  it('preserves tabs for a known repo whose worktrees have not loaded yet', () => {
    // Why (#1158): empty per-repo worktrees can mean a degraded local fetch or
    // SSH reconnect race, not that every persisted tab for the repo is stale.
    const store = createTestStore()
    const stalledWt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [] }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: stalledWt,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [stalledWt]: [makeTab({ id: 'tab1', worktreeId: stalledWt })]
      },
      terminalLayoutsByTabId: {
        tab1: makeLayout()
      }
    })

    const s = store.getState()
    expect(s.tabsByWorktree[stalledWt]).toHaveLength(1)
    expect(s.tabsByWorktree[stalledWt][0].id).toBe('tab1')
    expect(s.terminalLayoutsByTabId['tab1']).toBeDefined()
    expect(s.activeWorktreeId).toBe(stalledWt)
    expect(s.activeTabId).toBe('tab1')
  })

  it('preserves tabs for a known repo after a non-authoritative worktree fetch', () => {
    // Why (#1158): metadata fallback means the runtime did not prove deletion.
    const store = createTestStore()
    const stalledWt = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: {
        repo1: makeDetectedWorktreeResult('repo1', [], false)
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: stalledWt,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [stalledWt]: [makeTab({ id: 'tab1', worktreeId: stalledWt })]
      },
      terminalLayoutsByTabId: {
        tab1: makeLayout()
      }
    })

    const s = store.getState()
    expect(s.tabsByWorktree[stalledWt]).toHaveLength(1)
    expect(s.terminalLayoutsByTabId['tab1']).toBeDefined()
    expect(s.activeWorktreeId).toBe(stalledWt)
    expect(s.activeTabId).toBe('tab1')
  })

  it('drops tabs when an authoritative scan reports no matching worktrees', () => {
    // Why: once git has answered authoritatively, an empty repo list means
    // deleted local worktrees, not a startup race.
    const store = createTestStore()
    const staleWt = 'repo1::/path/deleted'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [] },
      detectedWorktreesByRepo: {
        repo1: makeDetectedWorktreeResult('repo1', [])
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: staleWt,
      activeTabId: 'tab-stale',
      tabsByWorktree: {
        [staleWt]: [makeTab({ id: 'tab-stale', worktreeId: staleWt })]
      },
      terminalLayoutsByTabId: {
        'tab-stale': makeLayout()
      }
    })

    const s = store.getState()
    expect(s.tabsByWorktree[staleWt]).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab-stale']).toBeUndefined()
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeTabId).toBeNull()
  })

  it('drops tabs for an unknown repo', () => {
    // Why: the carve-out only forgives missing worktrees for repos that still
    // exist in the repos list. If the user removed the whole repo, its tabs
    // are genuinely stale and must be dropped.
    const store = createTestStore()
    const orphanWt = 'repoGone::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [] }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: orphanWt,
      activeTabId: 'tab-orphan',
      tabsByWorktree: {
        [orphanWt]: [makeTab({ id: 'tab-orphan', worktreeId: orphanWt })]
      },
      terminalLayoutsByTabId: {
        'tab-orphan': makeLayout()
      }
    })

    const s = store.getState()
    expect(s.tabsByWorktree[orphanWt]).toBeUndefined()
    expect(s.terminalLayoutsByTabId['tab-orphan']).toBeUndefined()
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeTabId).toBeNull()
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

    // Why: restored tabs receive pendingActivationSpawn so the pane mount's
    // reattach (or fresh spawn if the daemon session died) does not count as
    // activity and bounce the worktree to the top of Recent.
    expect(s.tabsByWorktree[validWt][0].pendingActivationSpawn).toBe(true)

    // The restored-active worktree is marked ever-activated so a later click
    // doesn't retag (which would suppress a real codex-restart / new-pane bump).
    expect(s.everActivatedWorktreeIds.has(validWt)).toBe(true)
  })
})

describe('restored folder workspace hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps runtime folder workspace tabs, files, and browsers before remote catalogs load', () => {
    const store = createTestStore()
    const folderKey = folderWorkspaceKey('remote-folder')
    const groupId = 'group-folder'
    const editorFileId = '/srv/app/src/App.tsx'
    const session = {
      ...getDefaultWorkspaceSession(),
      activeWorkspaceKey: folderKey,
      activeWorktreeId: folderKey,
      activeTabId: 'terminal-folder',
      tabsByWorktree: {
        [folderKey]: [makeTab({ id: 'terminal-folder', worktreeId: folderKey })]
      },
      openFilesByWorktree: {
        [folderKey]: [
          {
            filePath: editorFileId,
            relativePath: 'src/App.tsx',
            worktreeId: folderKey,
            language: 'typescript'
          }
        ]
      },
      activeFileIdByWorktree: { [folderKey]: editorFileId },
      browserTabsByWorktree: {
        [folderKey]: [
          makeBrowserTab({
            id: 'browser-folder',
            worktreeId: folderKey,
            url: 'https://example.com'
          })
        ]
      },
      browserPagesByWorkspace: {
        'browser-folder': [
          {
            id: 'browser-page-folder',
            workspaceId: 'browser-folder',
            worktreeId: folderKey,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [folderKey]: 'browser-folder' },
      activeTabTypeByWorktree: { [folderKey]: 'browser' as const },
      unifiedTabs: {
        [folderKey]: [
          {
            id: 'terminal-folder',
            entityId: 'terminal-folder',
            groupId,
            worktreeId: folderKey,
            contentType: 'terminal' as const,
            label: 'Terminal',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: editorFileId,
            entityId: editorFileId,
            groupId,
            worktreeId: folderKey,
            contentType: 'editor' as const,
            label: 'App.tsx',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          },
          {
            id: 'browser-folder',
            entityId: 'browser-folder',
            groupId,
            worktreeId: folderKey,
            contentType: 'browser' as const,
            label: 'Example',
            customLabel: null,
            color: null,
            sortOrder: 2,
            createdAt: 3
          }
        ]
      },
      tabGroups: {
        [folderKey]: [
          {
            id: groupId,
            worktreeId: folderKey,
            activeTabId: 'browser-folder',
            tabOrder: ['terminal-folder', editorFileId, 'browser-folder'],
            recentTabIds: ['terminal-folder', editorFileId, 'browser-folder']
          }
        ]
      },
      activeGroupIdByWorktree: { [folderKey]: groupId }
    }
    const options = {
      additionalValidWorkspaceKeys: [folderKey],
      runtimeHostIdByWorkspaceSessionKey: { [folderKey]: 'runtime:env-1' as const }
    }

    store.getState().hydrateWorkspaceSession(session, options)
    store.getState().hydrateTabsSession(session, options)
    store.getState().hydrateEditorSession(session, options)
    store.getState().hydrateBrowserSession(session, options)

    const state = store.getState()
    expect(state.activeWorktreeId).toBe(folderKey)
    expect(state.activeWorkspaceKey).toBe(folderKey)
    expect(state.tabsByWorktree[folderKey]?.map((tab) => tab.id)).toEqual(['terminal-folder'])
    expect(state.unifiedTabsByWorktree[folderKey]?.map((tab) => tab.id)).toEqual([
      'terminal-folder',
      editorFileId,
      'browser-folder'
    ])
    expect(state.openFiles.map((file) => file.worktreeId)).toEqual([folderKey])
    expect(state.activeFileIdByWorktree[folderKey]).toBe(editorFileId)
    expect(state.browserTabsByWorktree[folderKey]?.map((tab) => tab.id)).toEqual(['browser-folder'])
    expect(state.browserPagesByWorkspace['browser-folder']?.[0]?.worktreeId).toBe(folderKey)
    expect(state.activeTabTypeByWorktree[folderKey]).toBe('browser')
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

  it('restores floating workspace browser tabs without a repo worktree', () => {
    const store = createTestStore()

    store.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    store.getState().hydrateBrowserSession({
      activeRepoId: null,
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          makeBrowserTab({
            id: 'floating-browser-1',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            url: 'https://example.com'
          })
        ]
      },
      activeBrowserTabIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-browser-1'
      },
      activeTabTypeByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'browser' }
    })

    const s = store.getState()
    expect(s.browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(s.activeBrowserTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe('floating-browser-1')
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

  it('preserves unrelated worktree tab arrays when recording a spawned PTY', () => {
    const store = createTestStore()
    const targetWorktreeId = 'repo1::/path/wt1'
    const otherWorktreeId = 'repo1::/path/wt2'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: targetWorktreeId, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: otherWorktreeId, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: {
        [targetWorktreeId]: [makeTab({ id: 'tab-1', worktreeId: targetWorktreeId })],
        [otherWorktreeId]: [makeTab({ id: 'tab-2', worktreeId: otherWorktreeId })]
      }
    })

    const before = store.getState().tabsByWorktree
    const beforeOtherTabs = before[otherWorktreeId]

    store.getState().updateTabPtyId('tab-1', 'pty-fresh')

    const after = store.getState().tabsByWorktree
    expect(after[targetWorktreeId]).not.toBe(before[targetWorktreeId])
    expect(after[otherWorktreeId]).toBe(beforeOtherTabs)
  })

  it('does not persist worktree activity when attaching a mirrored remote runtime PTY', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1', lastActivityAt: 1000 })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId })]
      }
    })

    store.getState().updateTabPtyId('tab-1', 'remote:web-env@@terminal-1')

    expect(store.getState().worktreesByRepo.repo1[0].lastActivityAt).toBe(1000)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('preserves unrelated worktree tab arrays when clearing a PTY', () => {
    const store = createTestStore()
    const targetWorktreeId = 'repo1::/path/wt1'
    const otherWorktreeId = 'repo1::/path/wt2'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: targetWorktreeId, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: otherWorktreeId, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: {
        [targetWorktreeId]: [
          makeTab({ id: 'tab-1', worktreeId: targetWorktreeId, ptyId: 'pty-fresh' })
        ],
        [otherWorktreeId]: [makeTab({ id: 'tab-2', worktreeId: otherWorktreeId })]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-fresh']
      }
    })

    const before = store.getState().tabsByWorktree
    const beforeOtherTabs = before[otherWorktreeId]

    store.getState().clearTabPtyId('tab-1', 'pty-fresh')

    const after = store.getState().tabsByWorktree
    expect(after[targetWorktreeId]).not.toBe(before[targetWorktreeId])
    expect(after[otherWorktreeId]).toBe(beforeOtherTabs)
  })

  it('changes only the owning worktree tab array when recording a PTY in a large session', () => {
    const store = createTestStore()
    const worktreeCount = 125
    const targetIndex = 73
    const worktrees = Array.from({ length: worktreeCount }, (_, index) =>
      makeWorktree({
        id: `repo1::/path/wt-${index}`,
        repoId: 'repo1',
        path: `/path/wt-${index}`
      })
    )
    const tabsByWorktree = Object.fromEntries(
      worktrees.map((worktree, index) => [
        worktree.id,
        [makeTab({ id: `tab-${index}`, worktreeId: worktree.id })]
      ])
    )

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: worktrees },
      tabsByWorktree
    })

    const targetTabId = `tab-${targetIndex}`
    const before = store.getState().tabsByWorktree

    store.getState().updateTabPtyId(targetTabId, 'pty-fresh')

    const after = store.getState().tabsByWorktree
    const changedWorktreeIds = Object.keys(after).filter(
      (worktreeId) => after[worktreeId] !== before[worktreeId]
    )
    expect(changedWorktreeIds).toEqual([`repo1::/path/wt-${targetIndex}`])
  })

  it('does not persist worktree activity when clearing a mirrored remote runtime PTY', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1', lastActivityAt: 1000 })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({
            id: 'tab-1',
            worktreeId,
            ptyId: 'remote:web-env@@terminal-1'
          })
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:web-env@@terminal-1']
      }
    })

    store.getState().clearTabPtyId('tab-1', 'remote:web-env@@terminal-1')

    expect(store.getState().worktreesByRepo.repo1[0].lastActivityAt).toBe(1000)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  // Why: clicking a worktree in the sidebar triggers a generation bump on
  // dead-PTY tabs which remounts TerminalPane and fresh-spawns a PTY. That
  // fresh spawn calls updateTabPtyId → bumpWorktreeActivity. Without the
  // pendingActivationSpawn tag, the just-clicked worktree would be stamped
  // with Date.now() and float to the top of Recent on every click. isReattach
  // is not set on fresh spawns, so this bug slips past PR 310e9daf.
  it('does not bump lastActivityAt when a click-driven fresh spawn follows setActiveWorktree', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const originalLastActivityAt = 1000

    // Why: a tab with a null ptyId triggers the allDead branch in
    // setActiveWorktree, which bumps generation and sets
    // pendingActivationSpawn so the subsequent fresh spawn is suppressed.
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            lastActivityAt: originalLastActivityAt
          })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: null })]
      },
      ptyIdsByTabId: { 'tab-1': [] },
      unifiedTabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [{ id: 'group-1', worktreeId, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' }
    })

    store.getState().setActiveWorktree(worktreeId)
    // The allDead generation bump tagged the tab with pendingActivationSpawn.
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(true)

    // Simulate the fresh spawn coming back from TerminalPane's remount.
    store.getState().updateTabPtyId('tab-1', 'pty-fresh')

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.lastActivityAt).toBe(originalLastActivityAt)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalledWith(
      expect.objectContaining({
        updates: expect.objectContaining({ lastActivityAt: expect.any(Number) })
      })
    )
    // The flag is consumed so a later legitimate respawn (codex restart etc.)
    // is not silently suppressed as well.
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBeUndefined()
  })

  it('bumps activation generation for slept wake-hint tabs with no live PTY', () => {
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
        [worktreeId]: [
          makeTab({
            id: 'tab-1',
            worktreeId,
            ptyId: 'wake-hint-session',
            generation: 2
          })
        ]
      },
      ptyIdsByTabId: { 'tab-1': [] },
      unifiedTabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [{ id: 'group-1', worktreeId, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' }
    })

    store.getState().setActiveWorktree(worktreeId)

    const tab = store.getState().tabsByWorktree[worktreeId][0]
    expect(tab.generation).toBe(3)
    expect(tab.pendingActivationSpawn).toBe(true)
  })

  // Why: the FIRST activation of a worktree tags every tab — even if tab.ptyId
  // already looks live, because reconnectPersistedTerminals can re-populate
  // tab.ptyId with a restored daemon session ID before the pane mounts, making
  // the upcoming updateTabPtyId look like new activity when it is really just
  // the click-driven reattach. Subsequent activations of the SAME worktree
  // must NOT re-tag — otherwise a later split-pane spawn or codex restart
  // would be silently suppressed.
  it('tags on first activation but not on re-activation', () => {
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
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'pty-restored' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-restored'] },
      unifiedTabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [{ id: 'group-1', worktreeId, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' }
    })

    // First activation: tabs get tagged even though tab.ptyId is non-null.
    store.getState().setActiveWorktree(worktreeId)
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(true)

    // updateTabPtyId from the pane mount consumes the tag.
    store.getState().updateTabPtyId('tab-1', 'pty-live')
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBeUndefined()

    // Switch away, then re-activate. The re-activation must NOT tag again,
    // or a later legitimate spawn (codex restart, new pane) would be dropped.
    store.getState().setActiveWorktree(null)
    store.getState().setActiveWorktree(worktreeId)
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBeUndefined()
  })

  // Why: re-activating a worktree whose PTYs died while the user was away (e.g.
  // relay disconnect, sleep) hits the allDead generation bump, which remounts
  // TerminalPane and fresh-spawns a PTY. That respawn is a side-effect of the
  // click, not real activity. First-activation tagging doesn't cover it
  // (everActivatedWorktreeIds already has the worktree), so without tagging the
  // allDead bump the worktree would stamp lastActivityAt and jump to the top of
  // Recent on every re-click — the reported "click bounces it to the top" bug.
  it('does not bump lastActivityAt when a re-activation respawns dead PTYs', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const originalLastActivityAt = 1000

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            lastActivityAt: originalLastActivityAt
          })
        ]
      },
      // Tab retains a wake-hint ptyId but has no live PTY, and the worktree was
      // already activated this session — so this is a re-activation, not a
      // first activation.
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'wake-hint-session' })]
      },
      ptyIdsByTabId: { 'tab-1': [] },
      everActivatedWorktreeIds: new Set([worktreeId]),
      unifiedTabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [{ id: 'group-1', worktreeId, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' }
    })

    store.getState().setActiveWorktree(worktreeId)
    // The allDead generation bump must tag the tab so the click-driven respawn
    // is suppressed, even though this is not the first activation.
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(true)

    const sortEpochBeforeSpawn = store.getState().sortEpoch

    // Simulate the stale wake-hint reattach failing before TerminalPane falls
    // back to a fresh spawn. The clear suppresses its own activity bump without
    // consuming the spawn suppression.
    store.getState().clearTabPtyId('tab-1', 'wake-hint-session')
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(true)

    // Simulate the fresh spawn coming back from TerminalPane's remount.
    store.getState().updateTabPtyId('tab-1', 'pty-fresh')

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.lastActivityAt).toBe(originalLastActivityAt)
    expect(store.getState().sortEpoch).toBe(sortEpochBeforeSpawn)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalledWith(
      expect.objectContaining({
        updates: expect.objectContaining({ lastActivityAt: expect.any(Number) })
      })
    )
    // The flag is consumed so a later legitimate respawn still bumps.
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBeUndefined()
  })

  it('suppresses every pane spawn from a click-driven split-layout remount', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const originalLastActivityAt = 1000

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            lastActivityAt: originalLastActivityAt
          })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: null })]
      },
      ptyIdsByTabId: { 'tab-1': [] },
      everActivatedWorktreeIds: new Set([worktreeId]),
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf-1' },
            second: { type: 'leaf', leafId: 'leaf-2' }
          },
          activeLeafId: 'leaf-1',
          expandedLeafId: null
        }
      },
      unifiedTabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab-1',
            entityId: 'tab-1',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktreeId]: [{ id: 'group-1', worktreeId, activeTabId: 'tab-1', tabOrder: ['tab-1'] }]
      },
      activeGroupIdByWorktree: { [worktreeId]: 'group-1' }
    })

    store.getState().setActiveWorktree(worktreeId)
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(2)

    store.getState().updateTabPtyId('tab-1', 'pty-pane-1')
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(true)

    store.getState().updateTabPtyId('tab-1', 'pty-pane-2')

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.lastActivityAt).toBe(originalLastActivityAt)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalledWith(
      expect.objectContaining({
        updates: expect.objectContaining({ lastActivityAt: expect.any(Number) })
      })
    )
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBeUndefined()
  })

  // Why: first-visit worktrees (no tabs yet) trigger Terminal.tsx's activation
  // fallback which calls createTab(). That auto-created tab passes
  // pendingActivationSpawn: true so its PTY spawn is suppressed — otherwise
  // clicking a never-visited worktree in the sidebar would stamp lastActivityAt
  // and reshuffle Recent/Smart (the user-reported bounce ~5s after click).
  it('does not bump lastActivityAt when createTab auto-creates for a first-visit worktree', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const originalLastActivityAt = 1000

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            lastActivityAt: originalLastActivityAt
          })
        ]
      },
      // No tabs yet — this is a fresh worktree the user is visiting for the
      // first time in this session.
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      activeWorktreeId: worktreeId
    })

    // Simulate Terminal.tsx's auto-create effect: tag as activation-driven.
    const newTab = store
      .getState()
      .createTab(worktreeId, undefined, undefined, { pendingActivationSpawn: true })

    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBe(true)

    // PTY comes back from the newly-mounted TerminalPane.
    store.getState().updateTabPtyId(newTab.id, 'pty-fresh')

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.lastActivityAt).toBe(originalLastActivityAt)
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalledWith(
      expect.objectContaining({
        updates: expect.objectContaining({ lastActivityAt: expect.any(Number) })
      })
    )
    // Flag is consumed — later legitimate respawns still bump.
    expect(store.getState().tabsByWorktree[worktreeId][0].pendingActivationSpawn).toBeUndefined()
  })

  // Why: real background events (agent output, OSC titles) must still bump
  // activity. Only the specific activation-driven spawn is suppressed.
  it('bumps lastActivityAt for a fresh spawn with no activation tag', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/path/wt1',
            lastActivityAt: 1000
          })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: null })]
      }
    })

    store.getState().updateTabPtyId('tab-1', 'pty-fresh')

    const worktree = store.getState().worktreesByRepo.repo1[0]
    expect(worktree.lastActivityAt).toBeGreaterThan(1000)
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId,
        updates: expect.objectContaining({ lastActivityAt: expect.any(Number) })
      })
    )
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
    return createTestStore()
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
      activeWorktreeIdsOnShutdown: [wt1]
    })

    expect(store.getState().workspaceSessionReady).toBe(false)
    expect(store.getState().tabsByWorktree[wt1][0].ptyId).toBeNull()
    expect(store.getState().tabsByWorktree[wt2][0].ptyId).toBeNull()
    expect(store.getState().pendingReconnectWorktreeIds).toEqual([wt1])

    await store.getState().reconnectPersistedTerminals()

    const s = store.getState()
    expect(s.workspaceSessionReady).toBe(true)
    // Why: Option 2 defers actual pty.spawn to connectPanePty. The store
    // records daemon session IDs as tab-level ptyIds so connectPanePty
    // can pass them as sessionId to the daemon's createOrAttach.
    expect(s.tabsByWorktree[wt1][0].ptyId).toBe('old-pty-1')
    expect(s.tabsByWorktree[wt2][0].ptyId).toBeNull()
    expect(s.ptyIdsByTabId.tab1).toEqual(['old-pty-1'])
    expect(s.ptyIdsByTabId.tab2).toEqual([])
    expect(
      computeVisibleWorktreeIds(s.worktreesByRepo, [wt1, wt2], {
        filterRepoIds: [],
        showSleepingWorkspaces: false,
        tabsByWorktree: s.tabsByWorktree,
        ptyIdsByTabId: s.ptyIdsByTabId,
        browserTabsByWorktree: s.browserTabsByWorktree,
        hideDefaultBranchWorkspace: false,
        hideAutomationGeneratedWorkspaces: false,
        repoMap: new Map(s.repos.map((repo) => [repo.id, repo])),
        workspaceHostScope: 'all',
        defaultHostId: LOCAL_EXECUTION_HOST_ID,
        worktreeLineageById: {}
      })
    ).toEqual([wt1])
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
    // ptyIdsByLeafId preserved from hydration for connectPanePty to consume,
    // but legacy pane:* leaves are reminted to durable UUID leaves at hydration.
    const layout = s.terminalLayoutsByTabId['tab1']
    const bindings = layout.ptyIdsByLeafId ?? {}
    expect(Object.keys(bindings)).toHaveLength(2)
    expect(Object.keys(bindings).every(isTerminalLeafId)).toBe(true)
    expect(Object.keys(bindings)).not.toContain('pane:1')
    expect(Object.keys(bindings)).not.toContain('pane:3')
    expect(Object.values(bindings).sort()).toEqual(['daemon-session-A', 'daemon-session-B'])
    expect(s.workspaceSessionReady).toBe(true)
  })

  it('does not advertise split-pane-only wake hints as hide-sleeping activity', async () => {
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

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt1,
      activeTabId: 'tab1',
      tabsByWorktree: {
        [wt1]: [makeTab({ id: 'tab1', worktreeId: wt1, ptyId: null })]
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
      activeWorktreeIdsOnShutdown: []
    })

    expect(store.getState().pendingReconnectWorktreeIds).toEqual([])

    await store.getState().reconnectPersistedTerminals()

    const s = store.getState()
    expect(s.terminalLayoutsByTabId.tab1?.ptyIdsByLeafId).toBeDefined()
    expect(s.ptyIdsByTabId.tab1).toEqual([])
    expect(
      computeVisibleWorktreeIds(s.worktreesByRepo, [wt1], {
        filterRepoIds: [],
        showSleepingWorkspaces: false,
        tabsByWorktree: s.tabsByWorktree,
        ptyIdsByTabId: s.ptyIdsByTabId,
        browserTabsByWorktree: s.browserTabsByWorktree,
        hideDefaultBranchWorkspace: false,
        hideAutomationGeneratedWorkspaces: false,
        repoMap: new Map(s.repos.map((repo) => [repo.id, repo])),
        workspaceHostScope: 'all',
        defaultHostId: LOCAL_EXECUTION_HOST_ID,
        worktreeLineageById: {}
      })
    ).toEqual([])
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
      activeTabTypeByWorktree: { [wt]: 'editor' },
      markdownFrontmatterVisible: { '/path/wt1/README.md': true }
    })

    const s = store.getState()
    expect(s.openFiles).toHaveLength(2)
    expect(s.openFiles[0].filePath).toBe('/path/wt1/src/index.ts')
    expect(s.openFiles[0].mode).toBe('edit')
    expect(s.openFiles[0].isDirty).toBe(false)
    expect(s.openFiles[1].isPreview).toBe(true)
    expect(s.markdownFrontmatterVisible).toEqual({ '/path/wt1/README.md': true })
    expect(s.activeFileId).toBe('/path/wt1/src/index.ts')
    expect(s.activeTabType).toBe('editor')
  })

  it('restores floating workspace markdown files without a repo worktree', () => {
    const store = createTestStore()
    const filePath = '/orca/userData/floating-workspace/note.md'
    const fileId = ownedEditorFileId(filePath, FLOATING_TERMINAL_WORKTREE_ID, null)

    store.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    store.getState().hydrateEditorSession({
      activeRepoId: null,
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            filePath,
            relativePath: 'note.md',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            language: 'markdown',
            runtimeEnvironmentId: null,
            dirtyDraftContent: ''
          }
        ]
      },
      activeFileIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: '/orca/userData/floating-workspace/note.md'
      },
      activeTabTypeByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'editor' }
    })

    const s = store.getState()
    expect(s.openFiles).toEqual([
      expect.objectContaining({
        id: fileId,
        filePath,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: null,
        isDirty: true
      })
    ])
    expect(s.editorDrafts).toEqual({ [fileId]: '' })
    expect(s.markdownFrontmatterVisible).toEqual({})
    expect(s.activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(fileId)
  })

  it('migrates hydrated front-matter visibility to owner-qualified editor file ids', () => {
    const store = createTestStore()
    const filePath = '/orca/userData/floating-workspace/note.md'
    const fileId = ownedEditorFileId(filePath, FLOATING_TERMINAL_WORKTREE_ID, null)

    store.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    store.getState().hydrateEditorSession({
      activeRepoId: null,
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            filePath,
            relativePath: 'note.md',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            language: 'markdown',
            runtimeEnvironmentId: null
          }
        ]
      },
      activeFileIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: filePath
      },
      activeTabTypeByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'editor' },
      markdownFrontmatterVisible: { [filePath]: true }
    })

    expect(store.getState().markdownFrontmatterVisible).toEqual({ [fileId]: true })
  })

  it('falls back to the floating workspace file id when duplicate paths are owner-qualified', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const sharedPath = '/path/wt1/README.md'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    store.getState().hydrateEditorSession({
      activeRepoId: 'repo1',
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [wt]: [
          {
            filePath: sharedPath,
            relativePath: 'README.md',
            worktreeId: wt,
            language: 'markdown'
          }
        ],
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            filePath: sharedPath,
            relativePath: 'README.md',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            language: 'markdown',
            runtimeEnvironmentId: null
          }
        ]
      },
      activeFileIdByWorktree: {
        [wt]: sharedPath,
        [FLOATING_TERMINAL_WORKTREE_ID]: sharedPath
      },
      activeTabTypeByWorktree: {
        [wt]: 'editor',
        [FLOATING_TERMINAL_WORKTREE_ID]: 'editor'
      }
    })

    const floatingActiveFileId =
      store.getState().activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
    expect(floatingActiveFileId).not.toBe(sharedPath)
    expect(
      store
        .getState()
        .openFiles.some(
          (file) =>
            file.id === floatingActiveFileId && file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID
        )
    ).toBe(true)
  })

  it('keeps same-path local and runtime legacy references on their original owners', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const filePath = '/path/wt1/src/app.ts'
    const runtimeEnvironmentId = 'runtime-1'
    const runtimeFileId = ownedEditorFileId(filePath, wt, runtimeEnvironmentId)
    const groupId = 'group-same-path-owners'

    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })

    const session = {
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [wt]: [
          {
            filePath,
            relativePath: 'src/app.ts',
            worktreeId: wt,
            language: 'typescript'
          },
          {
            filePath,
            relativePath: 'src/app.ts',
            worktreeId: wt,
            language: 'typescript',
            runtimeEnvironmentId
          }
        ]
      },
      activeFileIdByWorktree: { [wt]: filePath },
      activeTabTypeByWorktree: { [wt]: 'editor' as const },
      unifiedTabs: {
        [wt]: [
          {
            id: filePath,
            entityId: filePath,
            groupId,
            worktreeId: wt,
            contentType: 'editor' as const,
            label: 'app.ts',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: runtimeFileId,
            entityId: runtimeFileId,
            groupId,
            worktreeId: wt,
            contentType: 'editor' as const,
            label: 'app.ts',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      tabGroups: {
        [wt]: [
          {
            id: groupId,
            worktreeId: wt,
            activeTabId: filePath,
            tabOrder: [filePath, runtimeFileId],
            recentTabIds: [runtimeFileId, filePath]
          }
        ]
      },
      activeGroupIdByWorktree: { [wt]: groupId }
    }

    store.getState().hydrateTabsSession(session)
    store.getState().hydrateEditorSession(session)

    const s = store.getState()
    expect(s.openFiles).toEqual([
      expect.objectContaining({
        id: filePath,
        filePath,
        worktreeId: wt,
        runtimeEnvironmentId: undefined
      }),
      expect.objectContaining({
        id: runtimeFileId,
        filePath,
        worktreeId: wt,
        runtimeEnvironmentId
      })
    ])
    expect(s.activeFileIdByWorktree[wt]).toBe(filePath)
    expect(s.unifiedTabsByWorktree[wt]?.map((tab) => tab.id)).toEqual([filePath, runtimeFileId])
    expect(s.unifiedTabsByWorktree[wt]?.map((tab) => tab.entityId)).toEqual([
      filePath,
      runtimeFileId
    ])
    expect(s.groupsByWorktree[wt]?.[0]).toEqual(
      expect.objectContaining({
        activeTabId: filePath,
        tabOrder: [filePath, runtimeFileId],
        recentTabIds: [runtimeFileId, filePath]
      })
    )
  })

  it('keeps floating owner-qualified editor ids aligned with restored unified tabs', () => {
    const store = createTestStore()
    const sharedPath = '/path/wt1/README.md'
    const floatingFileId = ownedEditorFileId(sharedPath, FLOATING_TERMINAL_WORKTREE_ID, null)
    const groupId = 'floating-group-1'

    store.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    const session = {
      activeRepoId: null,
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            filePath: sharedPath,
            relativePath: 'README.md',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            language: 'markdown',
            runtimeEnvironmentId: null
          }
        ]
      },
      activeFileIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: floatingFileId
      },
      activeTabTypeByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'editor' as const },
      unifiedTabs: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: floatingFileId,
            entityId: floatingFileId,
            groupId,
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            contentType: 'editor' as const,
            label: 'README.md',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: groupId,
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            activeTabId: floatingFileId,
            tabOrder: [floatingFileId],
            recentTabIds: [floatingFileId]
          }
        ]
      },
      activeGroupIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: groupId }
    }

    store.getState().hydrateTabsSession(session)
    store.getState().hydrateEditorSession(session)

    const s = store.getState()
    expect(s.openFiles).toEqual([
      expect.objectContaining({
        id: floatingFileId,
        filePath: sharedPath,
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      })
    ])
    expect(s.activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(floatingFileId)
    expect(s.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([
      expect.objectContaining({
        id: floatingFileId,
        entityId: floatingFileId
      })
    ])
    expect(s.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([
      expect.objectContaining({
        activeTabId: floatingFileId,
        tabOrder: [floatingFileId],
        recentTabIds: [floatingFileId]
      })
    ])
  })

  it('migrates legacy floating unified tab file-path references to the hydrated owner id', () => {
    const store = createTestStore()
    const filePath = '/orca/userData/floating-workspace/README.md'
    const fileId = ownedEditorFileId(filePath, FLOATING_TERMINAL_WORKTREE_ID, null)
    const groupId = 'floating-group-legacy'

    store.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    const session = {
      activeRepoId: null,
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            filePath,
            relativePath: 'README.md',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            language: 'markdown',
            runtimeEnvironmentId: null
          }
        ]
      },
      activeFileIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: filePath },
      activeTabTypeByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'editor' as const },
      unifiedTabs: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: filePath,
            entityId: filePath,
            groupId,
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            contentType: 'editor' as const,
            label: 'README.md',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: groupId,
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            activeTabId: filePath,
            tabOrder: [filePath],
            recentTabIds: [filePath]
          }
        ]
      },
      activeGroupIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: groupId }
    }

    store.getState().hydrateTabsSession(session)
    store.getState().hydrateEditorSession(session)

    const s = store.getState()
    expect(s.openFiles[0]?.id).toBe(fileId)
    expect(s.activeFileIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(fileId)
    expect(s.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]).toEqual(
      expect.objectContaining({ id: fileId, entityId: fileId })
    )
    expect(s.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]).toEqual(
      expect.objectContaining({
        activeTabId: fileId,
        tabOrder: [fileId],
        recentTabIds: [fileId]
      })
    )
  })

  it('re-detects restored file languages instead of trusting stale session data', () => {
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
            filePath: '/path/wt1/notebooks/example.ipynb',
            relativePath: 'notebooks/example.ipynb',
            worktreeId: wt,
            language: 'json'
          }
        ]
      },
      activeFileIdByWorktree: { [wt]: '/path/wt1/notebooks/example.ipynb' },
      activeTabTypeByWorktree: { [wt]: 'editor' }
    })

    expect(store.getState().openFiles[0]).toEqual(
      expect.objectContaining({
        filePath: '/path/wt1/notebooks/example.ipynb',
        language: 'notebook'
      })
    )
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
