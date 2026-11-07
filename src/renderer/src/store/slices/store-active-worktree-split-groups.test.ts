import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  createTestStore,
  makeLayout,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import './terminal-orphan-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const mockApi = createStoreCascadesMockApi()

let main: TabsDrawnFromMain | undefined
afterEach(() => {
  main?.close()
  main = undefined
})

const itSwitchOff = it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)
const itSwitchOn = it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)

describe('setActiveWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  // Switch on, a second publication marks the pane as starting in main (twin below).
  itSwitchOff('publishes the first terminal and root tab group atomically', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const snapshots: { terminalCount: number; unifiedCount: number; groupCount: number }[] = []
    const unsubscribe = store.subscribe((state) => {
      snapshots.push({
        terminalCount: state.tabsByWorktree[wt]?.length ?? 0,
        unifiedCount: state.unifiedTabsByWorktree[wt]?.length ?? 0,
        groupCount: state.groupsByWorktree[wt]?.length ?? 0
      })
    })

    store.getState().createTab(wt)
    unsubscribe()

    // Intermediate terminal-only state races legacy/split-group hosts, duplicating panes and PTYs.
    expect(snapshots).toEqual([{ terminalCount: 1, unifiedCount: 1, groupCount: 1 }])
  })

  itSwitchOn(
    'publishes the first terminal and root tab group atomically, then marks it starting in main',
    () => {
      const store = createTestStore()
      const wt = 'repo1::/path/wt1'

      seedStore(store, {
        worktreesByRepo: {
          repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
        },
        groupsByWorktree: {},
        activeGroupIdByWorktree: {},
        unifiedTabsByWorktree: {}
      })

      const snapshots: { terminalCount: number; unifiedCount: number; groupCount: number }[] = []
      const unsubscribe = store.subscribe((state) => {
        snapshots.push({
          terminalCount: state.tabsByWorktree[wt]?.length ?? 0,
          unifiedCount: state.unifiedTabsByWorktree[wt]?.length ?? 0,
          groupCount: state.groupsByWorktree[wt]?.length ?? 0
        })
      })

      store.getState().createTab(wt)
      unsubscribe()

      // Intermediate terminal-only state races legacy/split-group hosts, duplicating panes and PTYs.
      expect(snapshots).toEqual([
        { terminalCount: 1, unifiedCount: 1, groupCount: 1 },
        { terminalCount: 1, unifiedCount: 1, groupCount: 1 }
      ])
      // The second publication is the pane's start mark, set before any render can mount the pane.
      expect(Object.values(store.getState().terminalPaneStartsByPaneKey)).toEqual([
        { status: 'starting' }
      ])
    }
  )

  it('promotes the next tab in the focused split into the global active surface on close', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const terminalTabId = 'terminal-1'
    const browserTabId = 'browser-1'
    const groupId = 'group-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt,
      activeTabType: 'browser',
      activeBrowserTabId: browserTabId,
      activeBrowserTabIdByWorktree: { [wt]: browserTabId },
      activeTabId: terminalTabId,
      activeTabIdByWorktree: { [wt]: terminalTabId },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      tabsByWorktree: {
        [wt]: [makeTab({ id: terminalTabId, worktreeId: wt })]
      },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: browserTabId,
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: terminalTabId,
            entityId: terminalTabId,
            worktreeId: wt,
            groupId,
            contentType: 'terminal'
          }),
          makeUnifiedTab({
            id: 'browser-view-1',
            entityId: browserTabId,
            worktreeId: wt,
            groupId,
            contentType: 'browser',
            label: 'Example'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: 'browser-view-1',
            tabOrder: [terminalTabId, 'browser-view-1']
          })
        ]
      },
      layoutByWorktree: {
        [wt]: { type: 'leaf', groupId }
      },
      activeGroupIdByWorktree: { [wt]: groupId }
    })
    main = await drawTabsFromMain(store)

    store.getState().closeBrowserTab(browserTabId)
    await main.settle()

    const s = store.getState()
    expect(s.groupsByWorktree[wt]?.[0]?.activeTabId).toBe(terminalTabId)
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeTabTypeByWorktree[wt]).toBe('terminal')
    expect(s.activeTabId).toBe(terminalTabId)
    expect(s.activeBrowserTabId).toBeNull()
    expect(s.activeBrowserTabIdByWorktree[wt]).toBeNull()
  })

  it('removes orphan terminal caches while creating a replacement tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: orphanId, worktreeId: wt })]
      },
      unifiedTabsByWorktree: {
        [wt]: []
      },
      ptyIdsByTabId: {
        [orphanId]: []
      },
      runtimePaneTitlesByTabId: {
        [orphanId]: { 1: 'stale' }
      },
      terminalLayoutsByTabId: {
        [orphanId]: makeLayout()
      },
      pendingStartupByTabId: {
        [orphanId]: { command: 'codex' }
      },
      automaticAgentResumeClaimsByTabId: {
        [orphanId]: {
          worktreeId: wt,
          launchAgent: 'codex',
          providerSession: { key: 'session_id', id: 'sess-1' }
        }
      },
      pendingInitialCwdByTabId: {
        [orphanId]: '/repo/packages/web'
      },
      tabBarOrderByWorktree: {
        [wt]: [orphanId]
      },
      cacheTimerByKey: {
        [`${orphanId}:seed`]: 123
      },
      activeTabId: orphanId,
      activeTabIdByWorktree: {
        [wt]: orphanId
      }
    })

    const replacement = store.getState().createTab(wt)
    const s = store.getState()

    expect(s.tabsByWorktree[wt]?.map((tab) => tab.id)).toEqual([replacement.id])
    expect(s.ptyIdsByTabId[orphanId]).toBeUndefined()
    expect(s.runtimePaneTitlesByTabId[orphanId]).toBeUndefined()
    expect(s.terminalLayoutsByTabId[orphanId]).toBeUndefined()
    expect(s.pendingStartupByTabId[orphanId]).toBeUndefined()
    expect(s.automaticAgentResumeClaimsByTabId[orphanId]).toBeUndefined()
    expect(s.pendingInitialCwdByTabId[orphanId]).toBeUndefined()
    expect(s.cacheTimerByKey[`${orphanId}:seed`]).toBeUndefined()
    const replacementLayout = s.terminalLayoutsByTabId[replacement.id]
    expect(replacementLayout?.root).toEqual({
      type: 'leaf',
      leafId: replacementLayout?.activeLeafId
    })
  })

  it('keeps surviving target-group tab active when inactive creation removes an orphan', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'
    const existingId = 'existing-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [
          makeTab({ id: orphanId, worktreeId: wt }),
          makeTab({ id: existingId, worktreeId: wt })
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: existingId,
            entityId: existingId,
            worktreeId: wt,
            groupId: 'group-1'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-1',
            worktreeId: wt,
            activeTabId: orphanId,
            tabOrder: [orphanId, existingId],
            recentTabIds: [orphanId]
          })
        ]
      },
      ptyIdsByTabId: {
        [orphanId]: [],
        [existingId]: []
      },
      activeTabId: orphanId,
      activeTabIdByWorktree: {
        [wt]: orphanId
      }
    })

    const created = store.getState().createTab(wt, 'group-1', undefined, { activate: false })
    const s = store.getState()

    expect(s.activeTabIdByWorktree[wt]).toBe(existingId)
    expect(s.groupsByWorktree[wt]?.[0]).toMatchObject({
      activeTabId: existingId,
      tabOrder: [existingId, created.id],
      recentTabIds: [existingId]
    })
  })

  it('keeps surviving non-target group tab active when inactive creation removes an orphan', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const orphanId = 'orphan-terminal'
    const existingId = 'existing-terminal'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [
          makeTab({ id: orphanId, worktreeId: wt }),
          makeTab({ id: existingId, worktreeId: wt })
        ]
      },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: existingId,
            entityId: existingId,
            worktreeId: wt,
            groupId: 'group-a'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: 'group-a',
            worktreeId: wt,
            activeTabId: orphanId,
            tabOrder: [orphanId, existingId],
            recentTabIds: [orphanId]
          }),
          makeTabGroup({
            id: 'group-b',
            worktreeId: wt,
            activeTabId: null,
            tabOrder: []
          })
        ]
      },
      ptyIdsByTabId: {
        [orphanId]: [],
        [existingId]: []
      }
    })

    const created = store.getState().createTab(wt, 'group-b', undefined, { activate: false })
    const groups = store.getState().groupsByWorktree[wt] ?? []

    expect(groups.find((group) => group.id === 'group-a')).toMatchObject({
      activeTabId: existingId,
      tabOrder: [existingId],
      recentTabIds: [existingId]
    })
    expect(groups.find((group) => group.id === 'group-b')).toMatchObject({
      activeTabId: created.id,
      tabOrder: [created.id]
    })
  })
})
