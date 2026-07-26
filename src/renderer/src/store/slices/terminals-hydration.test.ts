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

    // Why: ptyIdsByLeafId holds daemon session IDs that survive restart, letting each split-pane leaf reattach to its own session.
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

  it('strips the synthetic workspace suffix from folder-workspace instance placeholders', () => {
    const store = createTestStore()
    const workspaceUuid = '123e4567-e89b-12d3-a456-426614174000'
    const worktreeId = `folder-repo::/home/user::workspace:${workspaceUuid}`
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'folder-repo',
      activeWorktreeId: worktreeId,
      activeTabId: 'folder-tab',
      activeWorktreeIdsOnShutdown: [worktreeId],
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'folder-tab', worktreeId, ptyId: 'folder-session' })]
      }
    }

    store.getState().hydrateWorkspaceSession(session, {
      runtimeHostIdByWorkspaceSessionKey: {
        [worktreeWorkspaceKey(worktreeId)]: 'runtime:env-1'
      }
    })

    // Why: id keeps the ::workspace:<uuid> suffix, but path/displayName must resolve to the real folder so callers don't spawn against a missing cwd.
    expect(store.getState().worktreesByRepo['folder-repo']).toEqual([
      expect.objectContaining({ id: worktreeId, path: '/home/user', displayName: 'user' })
    ])
    expect(store.getState().repos).toEqual([
      expect.objectContaining({ id: 'folder-repo', path: '/home/user' })
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

    // Why: restart can preserve scrollback for an exited pane, so focus must land on a live PTY-backed pane, not the dead leaf.
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

  it('stashes deferred SSH session ids for worktrees not yet in worktreesByRepo', async () => {
    // Why: at cold start SSH worktrees aren't in worktreesByRepo, so the stash must fall back to the repo id embedded in the composite worktree id — else restored panes strand an "SSH connection is not active" toast.
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

  it('stops deferring a session once its SSH target is known-absent, but keeps deferring present targets', async () => {
    // #9911: a repo can outlive its SSH target (removed out of band). Once the
    // authoritative target list has loaded, its persisted session is dead — don't
    // re-defer it. A stranded deferred id reads as liveness in the orphan sweep, so
    // after a later missing-target pane mount clears ptyIdsByTabId it would pin the
    // dead tab forever. A present (merely disconnected) target must still defer.
    const store = createTestStore()
    const goneWt = 'repo-gone::/home/user/remote-gone'
    const liveWt = 'repo-live::/home/user/remote-live'
    seedStore(store, {
      repos: [
        { ...TEST_REPO, id: 'repo-gone', connectionId: 'ssh-target-removed' },
        { ...TEST_REPO, id: 'repo-live', connectionId: 'ssh-target-present' }
      ],
      worktreesByRepo: {},
      // Authoritative target list is loaded and lists only the present target.
      sshTargetsHydrated: true,
      sshTargetLabels: new Map([['ssh-target-present', 'Present']])
    })

    const session: WorkspaceSessionState = {
      activeRepoId: 'repo-live',
      activeWorktreeId: liveWt,
      activeTabId: 'tab-live',
      tabsByWorktree: {
        [goneWt]: [makeTab({ id: 'tab-gone', worktreeId: goneWt, ptyId: null })],
        [liveWt]: [makeTab({ id: 'tab-live', worktreeId: liveWt, ptyId: null })]
      },
      terminalLayoutsByTabId: {},
      activeWorktreeIdsOnShutdown: [goneWt, liveWt],
      remoteSessionIdsByTabId: {
        'tab-gone': 'ssh:ssh-target-removed@@pty-7',
        'tab-live': 'ssh:ssh-target-present@@pty-8'
      }
    }

    store.getState().hydrateWorkspaceSession(session)
    await store.getState().reconnectPersistedTerminals()

    // Removed target: no stranded deferred/pending reconnect evidence.
    expect(store.getState().deferredSshSessionIdsByTabId['tab-gone']).toBeUndefined()
    expect(store.getState().pendingReconnectPtyIdByTabId['tab-gone']).toBeUndefined()
    // Present-but-disconnected target: still deferred for a normal reconnect.
    expect(store.getState().deferredSshSessionIdsByTabId['tab-live']).toBe(
      'ssh:ssh-target-present@@pty-8'
    )
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
    // Why: seeding the restored worktree at index 0 gives the first user switch a prior entry, so Back isn't disabled until a second click.
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

    // Why: pre-seed stale values so the assertions can only pass if hydration actively overwrites nav history in this branch.
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
    // Why: the history seed must follow the validated activeWorktreeId (nulled when stale), or a deleted worktree sits at history[0] and fails Back.
    const store = createTestStore()
    seedStore(store, { worktreesByRepo: { repo1: [] } })

    // Why: pre-seed stale values so the assertions can only pass if hydration actively clears nav history for the invalid worktree.
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
    // Why: the hydration seed at index 0 lets the first sidebar click enable Back immediately (without it, Back needs a second click).
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
    // Why: default false so a startup error keeps the debounced writer gated off, protecting good on-disk state from an empty snapshot.
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
    // Why: hydration can populate state then throw downstream, so App.tsx flips the flag only after a clean return.
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
