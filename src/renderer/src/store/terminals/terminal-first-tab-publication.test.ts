import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import './terminal-orphan-cleanup'
import { createStoreCascadesMockApi } from '../testing/app-store-cascade-api.test-fixture'

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
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const mockApi = createStoreCascadesMockApi()

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
})
