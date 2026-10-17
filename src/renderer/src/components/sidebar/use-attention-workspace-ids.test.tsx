// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const agentStatusByPaneKey: Record<string, unknown> = {}
  return {
    state: {
      agentStatusByPaneKey,
      migrationUnsupportedByPtyId: {},
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      runtimePaneTitlesByTabId: {},
      terminalLayoutsByTabId: {},
      agentStatusEpoch: 0
    },
    buildAttentionWorkspaceIds: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('./attention-workspaces', () => ({
  buildAttentionWorkspaceIds: mocks.buildAttentionWorkspaceIds
}))

import {
  resetAttentionWorkspaceIdsForTests,
  useAttentionWorkspaceIds
} from './use-attention-workspace-ids'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  resetAttentionWorkspaceIdsForTests()
  mocks.state.agentStatusByPaneKey = {}
  mocks.state.agentStatusEpoch = 0
})

describe('useAttentionWorkspaceIds', () => {
  it('derives the set when enabled', () => {
    mocks.buildAttentionWorkspaceIds.mockReturnValue(new Set(['w1']))

    const { result } = renderHook(() => useAttentionWorkspaceIds(true))

    expect([...result.current]).toEqual(['w1'])
  })

  it('never touches the agent slices when disabled', () => {
    mocks.buildAttentionWorkspaceIds.mockReturnValue(new Set(['w1']))

    const { result, rerender } = renderHook(() => useAttentionWorkspaceIds(false))
    expect(result.current.size).toBe(0)

    mocks.state.agentStatusByPaneKey = { 'tab1:leaf': {} }
    mocks.state.agentStatusEpoch = 1
    rerender()

    expect(result.current.size).toBe(0)
    expect(mocks.buildAttentionWorkspaceIds).not.toHaveBeenCalled()
  })

  it('keeps the set identity while membership holds, so downstream memos survive', () => {
    mocks.buildAttentionWorkspaceIds.mockImplementation(() => new Set(['w1']))

    const { result, rerender } = renderHook(() => useAttentionWorkspaceIds(true))
    const first = result.current

    // A status write with an unchanged verdict: new epoch, same membership.
    mocks.state.agentStatusEpoch = 1
    rerender()

    expect(result.current).toBe(first)
  })

  it('re-derives when the verdict changes', () => {
    mocks.buildAttentionWorkspaceIds.mockReturnValueOnce(new Set(['w1']))
    const { result, rerender } = renderHook(() => useAttentionWorkspaceIds(true))
    expect([...result.current]).toEqual(['w1'])

    mocks.buildAttentionWorkspaceIds.mockReturnValueOnce(new Set())
    mocks.state.agentStatusEpoch = 1
    rerender()

    expect(result.current.size).toBe(0)
  })
})
