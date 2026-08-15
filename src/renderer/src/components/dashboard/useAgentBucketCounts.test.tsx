// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    repos: [],
    worktreesByRepo: {},
    tabsByWorktree: {},
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
  buildDashboardSnapshot: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('./build-dashboard-snapshot', () => ({
  buildDashboardSnapshot: mocks.buildDashboardSnapshot
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
    mocks.buildDashboardSnapshot.mockImplementation((state: { folderWorkspaces?: unknown[] }) => ({
      generatedAt: 1,
      cards: state.folderWorkspaces?.length ? [{ bucket: 'working' }] : []
    }))

    const { result } = renderHook(() => useAgentBucketCounts())

    expect(result.current).toEqual({ attention: 0, working: 1, done: 0, idle: 0 })
    expect(mocks.buildDashboardSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ folderWorkspaces: mocks.state.folderWorkspaces }),
      expect.any(Number),
      { includeCardDetails: false, includeFilterOptions: false }
    )
  })

  it('moves acknowledged completions to idle without recomputing for unrelated writes', () => {
    mocks.buildDashboardSnapshot.mockImplementation(
      (state: { acknowledgedAgentsByPaneKey?: Record<string, number> }) => ({
        generatedAt: 1,
        cards: [
          {
            bucket: state.acknowledgedAgentsByPaneKey?.['pane-done'] ? 'idle' : 'done'
          }
        ]
      })
    )
    const { result, rerender } = renderHook(() => useAgentBucketCounts())

    expect(result.current).toEqual({ attention: 0, working: 0, done: 1, idle: 0 })
    expect(mocks.buildDashboardSnapshot).toHaveBeenCalledTimes(1)

    mocks.state.unrelatedEpoch += 1
    rerender()
    expect(mocks.buildDashboardSnapshot).toHaveBeenCalledTimes(1)

    mocks.state.acknowledgedAgentsByPaneKey = { 'pane-done': 1 }
    rerender()
    expect(result.current).toEqual({ attention: 0, working: 0, done: 0, idle: 1 })
    expect(mocks.buildDashboardSnapshot).toHaveBeenCalledTimes(2)
  })
})
