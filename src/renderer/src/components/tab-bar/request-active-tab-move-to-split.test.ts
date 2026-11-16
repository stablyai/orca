import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetState = vi.fn()
const mockCanMove = vi.fn()
const mockMove = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockGetState()
  }
}))

vi.mock('./tab-move-to-pane-column', () => ({
  canMoveTabToNewPaneColumn: (...args: unknown[]) => mockCanMove(...args),
  moveTabToNewPaneColumn: (...args: unknown[]) => mockMove(...args)
}))

import { requestActiveTabMoveToSplit } from './request-active-tab-move-to-split'

describe('requestActiveTabMoveToSplit', () => {
  beforeEach(() => {
    mockGetState.mockReset()
    mockCanMove.mockReset()
    mockMove.mockReset()
  })

  it('returns false without preventable side effects when there is no active tab', () => {
    mockGetState.mockReturnValue({
      activeWorktreeId: 'wt-1',
      activeTabId: null,
      unifiedTabsByWorktree: { 'wt-1': [] }
    })
    expect(requestActiveTabMoveToSplit('right')).toBe(false)
    expect(mockMove).not.toHaveBeenCalled()
  })

  it('returns false when the group holds only one tab (layout no-op)', () => {
    mockGetState.mockReturnValue({
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-a',
      unifiedTabsByWorktree: {
        'wt-1': [{ id: 'tab-a', groupId: 'group-1' }]
      }
    })
    mockCanMove.mockReturnValue(false)
    expect(requestActiveTabMoveToSplit('right')).toBe(false)
    expect(mockCanMove).toHaveBeenCalledWith('tab-a', 'group-1')
    expect(mockMove).not.toHaveBeenCalled()
  })

  it('moves the active tab to a new pane column on the right', () => {
    mockGetState.mockReturnValue({
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-b',
      unifiedTabsByWorktree: {
        'wt-1': [
          { id: 'tab-a', groupId: 'group-1' },
          { id: 'tab-b', groupId: 'group-1' }
        ]
      }
    })
    mockCanMove.mockReturnValue(true)
    mockMove.mockReturnValue(true)

    expect(requestActiveTabMoveToSplit('right')).toBe(true)
    expect(mockMove).toHaveBeenCalledWith({
      unifiedTabId: 'tab-b',
      groupId: 'group-1',
      direction: 'right'
    })
  })
})
