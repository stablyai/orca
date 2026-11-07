import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { isTerminalLeafId } from '../../../../shared/workspace-layout/stable-pane-id'
import { createTestStore } from '../testing/app-store-test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import { makeTab, makeLayout } from './terminal-tab.test-fixture'
import { createStoreSessionMockApi } from '../testing/app-store-session-api.test-fixture'
import '@/components/sidebar/worktree-list/listing/visible-worktrees'
import { computeVisibleWorktreeIds } from '@/components/sidebar/worktree-list/listing/compute-visible-worktrees'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

// Mock pty-transport's eager buffer registration
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({
  registerEagerPtyBuffer: vi.fn().mockReturnValue({ flush: () => '', dispose: () => {} }),
  ensurePtyDispatcher: vi.fn()
}))

const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

const mockApi = createStoreSessionMockApi()

describe.each([false, true])('reconnectPersistedTerminals (layout owner is main: %s)', (isMain) => {
  let ptyIdCounter: number

  // Enable daemon before hydration or it clears reconnect state and stored PTY IDs.
  function createDaemonEnabledStore(): ReturnType<typeof createTestStore> {
    return createTestStore()
  }

  beforeEach(() => {
    layoutOwner.isMain = isMain
    vi.clearAllMocks()
    ptyIdCounter = 0
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
    expect((mockApi.pty as Record<string, unknown>).spawn).not.toHaveBeenCalled()
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
})
