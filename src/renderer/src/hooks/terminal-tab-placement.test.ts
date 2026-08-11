import { describe, expect, it, vi } from 'vitest'
import {
  applyTerminalTabPlacement,
  resolveTerminalTabPlacementGroupId
} from './terminal-tab-placement'

function createPlacementState(workerGroupId = 'group-left') {
  return {
    unifiedTabsByWorktree: {
      wt: [
        {
          id: 'tab-left',
          entityId: 'tab-left',
          groupId: 'group-left'
        },
        {
          id: 'tab-coordinator',
          entityId: 'tab-coordinator',
          groupId: 'group-right'
        },
        {
          id: 'tab-peer',
          entityId: 'tab-peer',
          groupId: 'group-right'
        },
        {
          id: 'tab-worker',
          entityId: 'tab-worker',
          groupId: workerGroupId
        }
      ]
    },
    groupsByWorktree: {
      wt: [
        {
          id: 'group-left',
          activeTabId: 'tab-left',
          tabOrder: ['tab-left', ...(workerGroupId === 'group-left' ? ['tab-worker'] : [])]
        },
        {
          id: 'group-right',
          activeTabId: 'tab-coordinator',
          tabOrder: [
            'tab-coordinator',
            'tab-peer',
            ...(workerGroupId === 'group-right' ? ['tab-worker'] : [])
          ]
        }
      ]
    },
    moveUnifiedTabToGroup: vi.fn(),
    reorderUnifiedTabs: vi.fn()
  }
}

describe('terminal tab placement', () => {
  it('resolves the split group that owns the anchor tab', () => {
    const state = createPlacementState()

    expect(
      resolveTerminalTabPlacementGroupId(state as never, 'wt', {
        afterTabId: 'tab-coordinator'
      })
    ).toBe('group-right')
  })

  it('moves an already-published worker after its coordinator without activating it', () => {
    const state = createPlacementState()

    applyTerminalTabPlacement(state as never, 'wt', 'tab-worker', {
      afterTabId: 'tab-coordinator'
    })

    expect(state.moveUnifiedTabToGroup).toHaveBeenCalledWith('tab-worker', 'group-right', {
      index: 1,
      activate: false,
      recordInteraction: false
    })
    expect(state.reorderUnifiedTabs).not.toHaveBeenCalled()
  })

  it('orders a fresh worker after its coordinator inside the same group', () => {
    const state = createPlacementState('group-right')

    applyTerminalTabPlacement(state as never, 'wt', 'tab-worker', {
      afterTabId: 'tab-coordinator'
    })

    expect(state.moveUnifiedTabToGroup).not.toHaveBeenCalled()
    expect(state.reorderUnifiedTabs).toHaveBeenCalledWith(
      'group-right',
      ['tab-coordinator', 'tab-worker', 'tab-peer'],
      { recordInteraction: false }
    )
  })

  it('leaves placement unchanged when the anchor is stale or belongs elsewhere', () => {
    const state = createPlacementState()

    expect(
      resolveTerminalTabPlacementGroupId(state as never, 'wt', { afterTabId: 'tab-missing' })
    ).toBeUndefined()
    expect(
      resolveTerminalTabPlacementGroupId(state as never, 'other-worktree', {
        afterTabId: 'tab-coordinator'
      })
    ).toBeUndefined()
    applyTerminalTabPlacement(state as never, 'wt', 'tab-worker', {
      afterTabId: 'tab-missing'
    })

    expect(state.moveUnifiedTabToGroup).not.toHaveBeenCalled()
    expect(state.reorderUnifiedTabs).not.toHaveBeenCalled()
  })
})
