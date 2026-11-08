import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeLayout, makeTab } from './terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import './terminal-orphan-cleanup'
import { createStoreCascadesMockApi } from '../testing/app-store-cascade-api.test-fixture'

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
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const mockApi = createStoreCascadesMockApi()

describe('setActiveWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
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

    const replacement = store.getState().createTab(wt, undefined, undefined, {
      id: 'replacement-terminal',
      initialLeafId: '11111111-1111-4111-8111-111111111111'
    })
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
      leafId: '11111111-1111-4111-8111-111111111111'
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
