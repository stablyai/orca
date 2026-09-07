import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { createTestStore, makeWorktree, makeTab, makeLayout } from './store-test-helpers'
import { computeVisibleWorktreeIds } from '@/components/sidebar/visible-worktrees'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { createStoreSessionMockApi } from './store-session-test-harness'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../../shared/ssh-types'

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

// Mock pty-transport's eager buffer registration
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn().mockReturnValue({ flush: () => '', dispose: () => {} }),
  ensurePtyDispatcher: vi.fn()
}))

const mockApi = createStoreSessionMockApi()

describe('reconnectPersistedTerminals', () => {
  let ptyIdCounter: number

  // Why: the daemon toggle must be on before hydration, else hydration clears reconnect state and tab.ptyId never rehydrates.
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
    // Why: spawn is deferred to connectPanePty; the store records daemon session IDs as tab-level ptyIds for it to reattach.
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
        worktreeIdsWithLiveAgent: new Set(),
        hideDefaultBranchWorkspace: false,
        hideAutomationGeneratedWorkspaces: false,
        hideCliCreatedWorkspaces: false,
        hideDetachedHeadWorkspaces: false,
        hideWorkspacesFromOtherDevices: false,
        pairedDeviceIdsByEnvironment: new Map(),
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

    // No activeWorktreeIdsOnShutdown — simulates a session from an older build.
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
    // Why: reconnect restores the tab-level ptyId so getWorktreeStatus() shows active (green dot) before the terminal mounts.
    expect(s.tabsByWorktree[wt1][0].ptyId).toBe('daemon-session-B')
    // ptyIdsByLeafId preserved for connectPanePty; legacy pane:* leaves reminted to durable UUID leaves at hydration.
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
        worktreeIdsWithLiveAgent: new Set(),
        hideDefaultBranchWorkspace: false,
        hideAutomationGeneratedWorkspaces: false,
        hideCliCreatedWorkspaces: false,
        hideDetachedHeadWorkspaces: false,
        hideWorkspacesFromOtherDevices: false,
        pairedDeviceIdsByEnvironment: new Map(),
        repoMap: new Map(s.repos.map((repo) => [repo.id, repo])),
        workspaceHostScope: 'all',
        defaultHostId: LOCAL_EXECUTION_HOST_ID,
        worktreeLineageById: {}
      })
    ).toEqual([])
  })
  it('leaves reconnect state untouched when cancellation is already signaled', async () => {
    const store = createDaemonEnabledStore()
    const worktreeId = 'repo1::/path/wt1'
    const tab = makeTab({ id: 'tab1', worktreeId, ptyId: null })
    store.setState({
      tabsByWorktree: { [worktreeId]: [tab] },
      ptyIdsByTabId: { tab1: [] },
      pendingReconnectWorktreeIds: [worktreeId],
      pendingReconnectTabByWorktree: { [worktreeId]: ['tab1'] },
      pendingReconnectPtyIdByTabId: { tab1: 'old-pty-1' },
      deferredSshSessionIdsByTabId: { tab1: 'deferred-pty-1' },
      workspaceSessionReady: false
    })
    const before = store.getState()
    const controller = new AbortController()
    controller.abort()

    await store.getState().reconnectPersistedTerminals(controller.signal)

    const after = store.getState()
    expect(after.tabsByWorktree).toBe(before.tabsByWorktree)
    expect(after.ptyIdsByTabId).toBe(before.ptyIdsByTabId)
    expect(after.pendingReconnectWorktreeIds).toBe(before.pendingReconnectWorktreeIds)
    expect(after.pendingReconnectTabByWorktree).toBe(before.pendingReconnectTabByWorktree)
    expect(after.pendingReconnectPtyIdByTabId).toBe(before.pendingReconnectPtyIdByTabId)
    expect(after.deferredSshSessionIdsByTabId).toBe(before.deferredSshSessionIdsByTabId)
    expect(after.workspaceSessionReady).toBe(false)
  })
  it('leaves reconnect state untouched when cancellation arrives before final publication', async () => {
    const store = createDaemonEnabledStore()
    const worktreeId = 'repo1::/path/wt1'
    store.setState({
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab1', worktreeId, ptyId: null })]
      },
      ptyIdsByTabId: { tab1: [] },
      pendingReconnectWorktreeIds: [worktreeId],
      pendingReconnectTabByWorktree: { [worktreeId]: ['tab1'] },
      pendingReconnectPtyIdByTabId: { tab1: 'old-pty-1' },
      deferredSshSessionIdsByTabId: { tab1: 'deferred-pty-1' },
      workspaceSessionReady: false
    })
    const before = store.getState()
    const controller = new AbortController()
    let abortReads = 0
    Object.defineProperty(controller.signal, 'aborted', {
      configurable: true,
      get: () => {
        abortReads += 1
        return abortReads > 1
      }
    })

    await store.getState().reconnectPersistedTerminals(controller.signal)

    const after = store.getState()
    expect(abortReads).toBe(2)
    expect(after.tabsByWorktree).toBe(before.tabsByWorktree)
    expect(after.ptyIdsByTabId).toBe(before.ptyIdsByTabId)
    expect(after.pendingReconnectWorktreeIds).toBe(before.pendingReconnectWorktreeIds)
    expect(after.pendingReconnectTabByWorktree).toBe(before.pendingReconnectTabByWorktree)
    expect(after.pendingReconnectPtyIdByTabId).toBe(before.pendingReconnectPtyIdByTabId)
    expect(after.deferredSshSessionIdsByTabId).toBe(before.deferredSshSessionIdsByTabId)
    expect(after.workspaceSessionReady).toBe(false)
  })

  it('leaves scoped reconnect state untouched when direct SSH authority is stale at entry', async () => {
    const store = createDaemonEnabledStore()
    const targetId = 'ssh-1'
    const worktreeId = 'repo1::/remote/wt1'
    const staleAuthority: DirectSshAuthority = {
      targetId,
      providerEpoch: 'epoch-1' as SshProviderEpoch,
      connectionGeneration: 1
    }
    store.setState({
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab1', worktreeId, ptyId: null })]
      },
      ptyIdsByTabId: { tab1: [] },
      pendingReconnectWorktreeIds: [worktreeId],
      pendingReconnectTabByWorktree: { [worktreeId]: ['tab1'] },
      pendingReconnectPtyIdByTabId: { tab1: 'ssh:ssh-1@@relay-1' },
      deferredSshSessionIdsByTabId: { tab1: 'ssh:ssh-1@@deferred-1' },
      sshConnectionStates: new Map([
        [
          targetId,
          {
            targetId,
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: staleAuthority.providerEpoch,
            connectionGeneration: 2
          }
        ]
      ]),
      workspaceSessionReady: false
    })
    const before = store.getState()

    await store.getState().reconnectPersistedTerminals(undefined, {
      directSshAuthority: staleAuthority,
      workspaceKeys: [worktreeId]
    })

    const after = store.getState()
    expect(after.tabsByWorktree).toBe(before.tabsByWorktree)
    expect(after.ptyIdsByTabId).toBe(before.ptyIdsByTabId)
    expect(after.pendingReconnectWorktreeIds).toBe(before.pendingReconnectWorktreeIds)
    expect(after.pendingReconnectTabByWorktree).toBe(before.pendingReconnectTabByWorktree)
    expect(after.pendingReconnectPtyIdByTabId).toBe(before.pendingReconnectPtyIdByTabId)
    expect(after.deferredSshSessionIdsByTabId).toBe(before.deferredSshSessionIdsByTabId)
    expect(after.workspaceSessionReady).toBe(before.workspaceSessionReady)
  })

  it('leaves scoped reconnect state untouched when direct SSH authority rotates before publication', async () => {
    const store = createDaemonEnabledStore()
    const targetId = 'ssh-1'
    const worktreeId = 'repo1::/remote/wt1'
    const authority: DirectSshAuthority = {
      targetId,
      providerEpoch: 'epoch-1' as SshProviderEpoch,
      connectionGeneration: 1
    }
    let authorityReads = 0
    const currentAuthorityState = {
      targetId,
      status: 'connected' as const,
      error: null,
      reconnectAttempt: 0,
      providerEpoch: authority.providerEpoch,
      connectionGeneration: authority.connectionGeneration
    }
    const rotatedAuthorityState = {
      ...currentAuthorityState,
      connectionGeneration: 2
    }
    const sshConnectionStates = new Map([[targetId, currentAuthorityState]])
    const originalGet = sshConnectionStates.get.bind(sshConnectionStates)
    // Rotate from the first read after the entry authority check, so the
    // pre-publication check sees the new generation whatever number of
    // intermediate reads the reconnect pass happens to make.
    sshConnectionStates.get = ((key: string) => {
      authorityReads += 1
      return authorityReads >= 2 ? rotatedAuthorityState : originalGet(key)
    }) as typeof sshConnectionStates.get
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: targetId
        }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/remote/wt1' })]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab1', worktreeId, ptyId: null })]
      },
      ptyIdsByTabId: { tab1: [] },
      pendingReconnectWorktreeIds: [worktreeId],
      pendingReconnectTabByWorktree: { [worktreeId]: ['tab1'] },
      pendingReconnectPtyIdByTabId: { tab1: 'ssh:ssh-1@@relay-1' },
      deferredSshSessionIdsByTabId: {},
      sshConnectionStates,
      workspaceSessionReady: false
    })
    const before = store.getState()

    await store.getState().reconnectPersistedTerminals(undefined, {
      directSshAuthority: authority,
      workspaceKeys: [worktreeId]
    })

    const after = store.getState()
    expect(authorityReads).toBeGreaterThanOrEqual(2)
    expect(after.tabsByWorktree).toBe(before.tabsByWorktree)
    expect(after.ptyIdsByTabId).toBe(before.ptyIdsByTabId)
    expect(after.pendingReconnectWorktreeIds).toBe(before.pendingReconnectWorktreeIds)
    expect(after.pendingReconnectTabByWorktree).toBe(before.pendingReconnectTabByWorktree)
    expect(after.pendingReconnectPtyIdByTabId).toBe(before.pendingReconnectPtyIdByTabId)
    expect(after.deferredSshSessionIdsByTabId).toBe(before.deferredSshSessionIdsByTabId)
    expect(after.workspaceSessionReady).toBe(false)
  })
})
