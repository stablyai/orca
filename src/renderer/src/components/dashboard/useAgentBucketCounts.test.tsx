// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    repos: [],
    worktreesByRepo: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    folderWorkspaces: [{ id: 'folder-1' }],
    acknowledgedAgentsByPaneKey: {} as Record<string, number>,
    unrelatedEpoch: 0,
    agentStatusEpoch: 0
  },
  buildDashboardBucketCounts: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('./build-dashboard-bucket-counts', () => ({
  buildDashboardBucketCounts: mocks.buildDashboardBucketCounts,
  createDashboardBucketCountsCache: () => ({
    byWorktree: new Map(),
    computeCount: 0,
    lastComputedWorktreeIds: []
  })
}))

import { useAgentBucketCounts } from './useAgentBucketCounts'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.state.acknowledgedAgentsByPaneKey = {}
  mocks.state.unrelatedEpoch = 0
})

describe('useAgentBucketCounts', () => {
  it('includes folder workspaces in the count snapshot inputs', () => {
    mocks.buildDashboardBucketCounts.mockImplementation(
      (state: { folderWorkspaces?: unknown[] }) => ({
        attention: 0,
        working: state.folderWorkspaces?.length ? 1 : 0,
        done: 0,
        idle: 0
      })
    )

    const { result } = renderHook(() => useAgentBucketCounts())

    expect(result.current).toEqual({ attention: 0, working: 1, done: 0, idle: 0 })
    expect(mocks.buildDashboardBucketCounts).toHaveBeenCalledWith(
      expect.objectContaining({
        folderWorkspaces: mocks.state.folderWorkspaces,
        unifiedTabsByWorktree: mocks.state.unifiedTabsByWorktree
      }),
      expect.any(Number),
      expect.objectContaining({ byWorktree: expect.any(Map) }),
      expect.anything()
    )
  })

  it('moves acknowledged completions to idle without recomputing for unrelated writes', () => {
    mocks.buildDashboardBucketCounts.mockImplementation(
      (state: { acknowledgedAgentsByPaneKey?: Record<string, number> }) => ({
        attention: 0,
        working: 0,
        done: state.acknowledgedAgentsByPaneKey?.['pane-done'] ? 0 : 1,
        idle: state.acknowledgedAgentsByPaneKey?.['pane-done'] ? 1 : 0
      })
    )
    const { result, rerender } = renderHook(() => useAgentBucketCounts())

    expect(result.current).toEqual({ attention: 0, working: 0, done: 1, idle: 0 })
    expect(mocks.buildDashboardBucketCounts).toHaveBeenCalledTimes(1)

    mocks.state.unrelatedEpoch += 1
    rerender()
    expect(mocks.buildDashboardBucketCounts).toHaveBeenCalledTimes(1)

    mocks.state.acknowledgedAgentsByPaneKey = { 'pane-done': 1 }
    rerender()
    expect(result.current).toEqual({ attention: 0, working: 0, done: 0, idle: 1 })
    expect(mocks.buildDashboardBucketCounts).toHaveBeenCalledTimes(2)
  })
})
