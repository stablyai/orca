// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceMultiplexerState } from '../../../../shared/workspace-multiplexer-types'
import { useWorkspaceMultiplexerPageActions } from './use-workspace-multiplexer-page-actions'

const state = vi.hoisted(() => ({ workspaceMultiplexer: {} as WorkspaceMultiplexerState }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
afterEach(cleanup)

function seedGroupedWorkspaces(): void {
  state.workspaceMultiplexer = {
    slots: ['hidden', 'visible', 'other'].map((id) => ({
      id,
      worktreeId: id,
      executionHostId: 'local',
      groupId: null,
      activeTerminalTabId: null
    })),
    panes: [
      { id: 'first', activeSlotId: 'visible', slotOrder: ['hidden', 'visible'] },
      { id: 'second', activeSlotId: 'other', slotOrder: ['other'] }
    ],
    layout: {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', groupId: 'first' },
      second: { type: 'leaf', groupId: 'second' }
    }
  }
}

it('initially focuses the visible tab instead of the first stored slot', () => {
  seedGroupedWorkspaces()
  const { result } = renderHook(() => useWorkspaceMultiplexerPageActions([]))
  expect(result.current.focusedSlotId).toBe('visible')
})

it('keeps zoom within a pane and restores the layout when focus moves to another pane', () => {
  seedGroupedWorkspaces()
  const { result } = renderHook(() => useWorkspaceMultiplexerPageActions([]))
  act(() => result.current.setExpandedPaneId('first'))
  act(() => result.current.focusSlot(state.workspaceMultiplexer.slots[1]!, null))
  expect(result.current.expandedPaneId).toBe('first')
  act(() => result.current.focusSlot(state.workspaceMultiplexer.slots[2]!, null))
  expect(result.current.expandedPaneId).toBeNull()
})
