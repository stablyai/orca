import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
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

import type { WorkspaceSessionState } from '../../../../shared/types'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  getDefaultWorkspaceSession
} from '../../../../shared/constants'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  createTestStore,
  makeLayout,
  makeTab,
  makeWorktree,
  seedStore,
  TEST_REPO
} from './store-test-helpers'
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

  it('hydrates runtime-owned tabs from host partitions before remote catalogs load', () => {
    const store = createTestStore()
    const worktreeId = 'remote-repo::/srv/remote-wt'
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'remote-repo',
      activeWorktreeId: worktreeId,
      activeTabId: 'remote-tab',
      activeWorktreeIdsOnShutdown: [worktreeId],
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({
            id: 'remote-tab',
            worktreeId,
            ptyId: 'remote-session'
          })
        ]
      },
      remoteSessionIdsByTabId: { 'remote-tab': 'remote-session' }
    }

    store.getState().hydrateWorkspaceSession(session, {
      runtimeHostIdByWorkspaceSessionKey: { [worktreeId]: 'runtime:env-1' }
    })

    expect(store.getState().tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([
      'remote-tab'
    ])
    expect(store.getState().activeWorktreeId).toBe(worktreeId)
    expect(store.getState().activeRepoId).toBe('remote-repo')
    expect(store.getState().pendingReconnectWorktreeIds).toEqual([worktreeId])
    expect(store.getState().pendingReconnectPtyIdByTabId).toEqual({
      'remote-tab': 'remote-session'
    })
    expect(store.getState().repos).toEqual([
      expect.objectContaining({
        id: 'remote-repo',
        executionHostId: 'runtime:env-1'
      })
    ])
    expect(store.getState().worktreesByRepo['remote-repo']).toEqual([
      expect.objectContaining({
        id: worktreeId,
        hostId: 'runtime:env-1'
      })
    ])
  })

  it('avoids duplicate repo placeholders when a same-id local repo is already loaded', () => {
    const store = createTestStore()
    const worktreeId = 'same-repo::/srv/remote-wt'
    store.setState({
      repos: [
        {
          id: 'same-repo',
          path: '/Users/me/same-repo',
          displayName: 'Same repo',
          badgeColor: '#000',
          addedAt: 1,
          connectionId: null,
          executionHostId: 'local'
        }
      ],
      worktreesByRepo: {}
    })
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'same-repo',
      activeWorktreeId: worktreeId,
      activeTabId: 'remote-tab',
      activeWorktreeIdsOnShutdown: [worktreeId],
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({
            id: 'remote-tab',
            worktreeId,
            ptyId: 'remote-session'
          })
        ]
      }
    }

    store.getState().hydrateWorkspaceSession(session, {
      runtimeHostIdByWorkspaceSessionKey: {
        [worktreeWorkspaceKey(worktreeId)]: 'runtime:env-1'
      }
    })

    expect(store.getState().repos.map((repo) => `${repo.id}:${repo.executionHostId}`)).toEqual([
      'same-repo:local'
    ])
    expect(store.getState().worktreesByRepo['same-repo']).toEqual([
      expect.objectContaining({ id: worktreeId, hostId: 'runtime:env-1' })
    ])
    expect(store.getState().tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([
      'remote-tab'
    ])
  })

  it('hydrates runtime folder workspace tabs before remote folder catalogs load', () => {
    const store = createTestStore()
    const folderKey = folderWorkspaceKey('folder-1')
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorkspaceKey: folderKey,
      activeWorktreeId: folderKey,
      activeTabId: 'remote-folder-tab',
      activeWorktreeIdsOnShutdown: [folderKey],
      tabsByWorktree: {
        [folderKey]: [
          makeTab({
            id: 'remote-folder-tab',
            worktreeId: folderKey,
            ptyId: 'remote-folder-session'
          })
        ]
      },
      remoteSessionIdsByTabId: { 'remote-folder-tab': 'remote-folder-session' }
    }

    store.getState().hydrateWorkspaceSession(session, {
      additionalValidWorkspaceKeys: [folderKey],
      runtimeHostIdByWorkspaceSessionKey: { [folderKey]: 'runtime:env-1' }
    })

    expect(store.getState().tabsByWorktree[folderKey]?.map((tab) => tab.id)).toEqual([
      'remote-folder-tab'
    ])
    expect(store.getState().activeWorktreeId).toBe(folderKey)
    expect(store.getState().activeWorkspaceKey).toBe(folderKey)
    expect(store.getState().pendingReconnectWorktreeIds).toEqual([folderKey])
    expect(store.getState().pendingReconnectPtyIdByTabId).toEqual({
      'remote-folder-tab': 'remote-folder-session'
    })
    expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({
      [folderKey]: 'runtime:env-1'
    })
  })

  it('moves restored active focus from a dead split leaf to a pty-backed sibling', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/wt-1'
    const liveLeftLeafId = '9ee09218-72a5-4e1c-b075-729e937d4e29'
    const liveRightLeafId = 'f5fc66b1-ec43-404b-b7b0-a06f0db34940'
    const deadActiveLeafId = 'fbf63fd9-34d6-4387-9109-562f7c02bc4c'
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
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: liveLeftLeafId },
            second: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: liveRightLeafId },
              second: { type: 'leaf', leafId: deadActiveLeafId }
            }
          },
          activeLeafId: deadActiveLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [liveLeftLeafId]: 'daemon-session-left',
            [liveRightLeafId]: 'daemon-session-right'
          },
          buffersByLeafId: {
            [deadActiveLeafId]: 'retained scrollback'
          }
        }
      }
    }

    store.getState().hydrateWorkspaceSession(session)

    // Why: restart can preserve scrollback for an exited pane while live siblings
    // reattach. Keyboard focus must land on a PTY-backed pane, not the dead leaf.
    expect(store.getState().terminalLayoutsByTabId['tab-1']?.activeLeafId).toBe(liveLeftLeafId)
  })

  it('hydrates floating terminal tabs even though they are not repo worktrees', () => {
    const store = createTestStore()
    const session: WorkspaceSessionState = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          makeTab({
            id: 'floating-tab-1',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            ptyId: 'floating-pty-1'
          })
        ]
      },
      terminalLayoutsByTabId: {
        'floating-tab-1': makeLayout()
      },
      activeTabIdByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: 'floating-tab-1'
      },
      activeWorktreeIdsOnShutdown: [FLOATING_TERMINAL_WORKTREE_ID]
    }

    store.getState().hydrateWorkspaceSession(session)

    expect(store.getState().tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(store.getState().activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      'floating-tab-1'
    )
    expect(store.getState().pendingReconnectWorktreeIds).toEqual([FLOATING_TERMINAL_WORKTREE_ID])
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

    // Why: startup restores every daemon wake hint, but subscribers should see
    // one ready-state transition instead of one update per restored tab.
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

  it('stashes deferred SSH session ids for worktrees not yet in worktreesByRepo', async () => {
    // Why: at cold start SSH worktrees are absent from worktreesByRepo (relay
    // discovery needs the connection). The deferred stash must fall back to
    // the repo id embedded in the composite worktree id — otherwise restored
    // SSH panes fresh-spawn into a missing PTY provider and strand an
    // "SSH connection is not active" toast.
    const store = createTestStore()
    const worktreeId = 'repo1::/home/user/remote-project'
    const sshSessionId = 'ssh:ssh-target-1@@pty-7'
    seedStore(store, {
      repos: [{ ...TEST_REPO, connectionId: 'ssh-target-1' }],
      worktreesByRepo: {}
    })

    const session: WorkspaceSessionState = {
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabId: 'tab-1',
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: null })]
      },
      terminalLayoutsByTabId: {},
      activeWorktreeIdsOnShutdown: [worktreeId],
      remoteSessionIdsByTabId: { 'tab-1': sshSessionId }
    }

    store.getState().hydrateWorkspaceSession(session)
    await store.getState().reconnectPersistedTerminals()

    expect(store.getState().deferredSshSessionIdsByTabId).toMatchObject({
      'tab-1': sshSessionId
    })
  })

  it('resets persisted agent titles to the fallback label on hydration', () => {
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
      terminalLayoutsByTabId: {},
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, title: '* Claude done', ptyId: '207' })]
      }
    }

    store.getState().hydrateWorkspaceSession(session)

    expect(store.getState().tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({
        id: 'tab-1',
        title: 'Terminal 1',
        ptyId: null
      })
    ])
  })

  it('hydrates the default-tab idempotency marker', () => {
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
      terminalLayoutsByTabId: {},
      tabsByWorktree: {},
      defaultTerminalTabsAppliedByWorktreeId: { [worktreeId]: true }
    }

    store.getState().hydrateWorkspaceSession(session)

    expect(store.getState().defaultTerminalTabsAppliedByWorktreeId).toEqual({
      [worktreeId]: true
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

  it('restores the active repo main worktree when the session has no active terminal tabs', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/wt-main'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo1',
            path: '/wt-main',
            isMainWorktree: true
          })
        ]
      }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    })

    expect(store.getState().activeWorktreeId).toBe(worktreeId)
    expect(store.getState().activeWorkspaceKey).toBe(`worktree:${worktreeId}`)
    expect(store.getState().worktreeNavHistory).toEqual([worktreeId])
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

describe('hydrationSucceeded flag (issue #1158)', () => {
  it('defaults to false so the session writer is gated off at startup', () => {
    // Why: App.tsx only flips hydrationSucceeded=true after a clean load from
    // orca-data.json. If a startup error prevents that call, the flag stays
    // false and the debounced writer never fires — protecting the user's good
    // on-disk state from being overwritten with an empty in-memory snapshot.
    const store = createTestStore()
    expect(store.getState().hydrationSucceeded).toBe(false)
  })

  it('setHydrationSucceeded toggles the flag both ways', () => {
    const store = createTestStore()
    store.getState().setHydrationSucceeded(true)
    expect(store.getState().hydrationSucceeded).toBe(true)
    store.getState().setHydrationSucceeded(false)
    expect(store.getState().hydrationSucceeded).toBe(false)
  })

  it('hydrateWorkspaceSession does not flip hydrationSucceeded on its own', () => {
    // Why: the hydration call can populate state partially and still throw
    // downstream (e.g. reconnect fails). Leaving the flip to App.tsx — after
    // hydrateWorkspaceSession has returned without throwing — keeps the gate
    // honest in those mid-flight failures.
    const store = createTestStore()
    const wt = 'repo1::/wt'
    seedStore(store, {
      worktreesByRepo: { repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/wt' })] }
    })

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: wt,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    })

    expect(store.getState().hydrationSucceeded).toBe(false)
  })
})
