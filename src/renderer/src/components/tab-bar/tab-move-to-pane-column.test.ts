import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import type { Tab } from '../../../../shared/tab-types'
import {
  canMoveTabToNewPaneColumn,
  moveActiveTabToNextPaneColumn,
  moveTabToNewPaneColumn
} from './tab-move-to-pane-column'

const WT = 'wt-1'

const mocks = vi.hoisted(() => ({
  mirrorWebRuntimeTabMove: vi.fn()
}))

vi.mock('./web-runtime-tab-move-mirror', () => ({
  mirrorWebRuntimeTabMove: mocks.mirrorWebRuntimeTabMove
}))

describe('tab-move-to-pane-column', () => {
  beforeEach(() => {
    mocks.mirrorWebRuntimeTabMove.mockReset()
    useAppStore.setState({
      activeWorktreeId: WT,
      groupsByWorktree: {
        [WT]: [
          {
            id: 'group-1',
            worktreeId: WT,
            activeTabId: 'tab-a',
            tabOrder: ['tab-a', 'tab-b']
          }
        ]
      },
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id: 'tab-a',
            groupId: 'group-1',
            worktreeId: WT,
            contentType: 'terminal',
            entityId: 'term-a',
            label: 'A',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          } satisfies Tab,
          {
            id: 'tab-b',
            groupId: 'group-1',
            worktreeId: WT,
            contentType: 'terminal',
            entityId: 'term-b',
            label: 'B',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          } satisfies Tab
        ]
      },
      layoutByWorktree: {
        [WT]: { type: 'leaf', groupId: 'group-1' }
      }
    })
  })

  it('allows moving when the source group has more than one tab', () => {
    expect(canMoveTabToNewPaneColumn('tab-b', 'group-1')).toBe(true)
  })

  it('blocks moving the only tab in a group', () => {
    useAppStore.setState({
      groupsByWorktree: {
        [WT]: [
          {
            id: 'group-1',
            worktreeId: WT,
            activeTabId: 'tab-a',
            tabOrder: ['tab-a']
          }
        ]
      }
    })

    expect(canMoveTabToNewPaneColumn('tab-a', 'group-1')).toBe(false)
    expect(
      moveTabToNewPaneColumn({ unifiedTabId: 'tab-a', groupId: 'group-1', direction: 'right' })
    ).toBe(false)
  })

  it('creates a sibling split pane via dropUnifiedTab', () => {
    const dropUnifiedTab = vi.fn(() => true)
    useAppStore.setState({ dropUnifiedTab } as Partial<ReturnType<typeof useAppStore.getState>>)

    expect(
      moveTabToNewPaneColumn({ unifiedTabId: 'tab-b', groupId: 'group-1', direction: 'right' })
    ).toBe(true)
    expect(dropUnifiedTab).toHaveBeenCalledWith('tab-b', {
      groupId: 'group-1',
      splitDirection: 'right'
    })
    expect(mocks.mirrorWebRuntimeTabMove).toHaveBeenCalledWith({
      kind: 'split',
      worktreeId: WT,
      tabId: 'tab-b',
      targetGroupId: 'group-1',
      splitDirection: 'right'
    })
  })

  it('does not mirror when the local store rejects the move', () => {
    const dropUnifiedTab = vi.fn(() => false)
    useAppStore.setState({ dropUnifiedTab } as Partial<ReturnType<typeof useAppStore.getState>>)

    expect(
      moveTabToNewPaneColumn({ unifiedTabId: 'tab-b', groupId: 'group-1', direction: 'right' })
    ).toBe(false)
    expect(mocks.mirrorWebRuntimeTabMove).not.toHaveBeenCalled()
  })

  it('splits the active tab into a new column when no next group exists', () => {
    const dropUnifiedTab = vi.fn(() => true)
    useAppStore.setState({
      dropUnifiedTab,
      activeGroupIdByWorktree: { [WT]: 'group-1' }
    } as Partial<ReturnType<typeof useAppStore.getState>>)

    expect(moveActiveTabToNextPaneColumn('right')).toBe(true)
    expect(dropUnifiedTab).toHaveBeenCalledWith('tab-a', {
      groupId: 'group-1',
      splitDirection: 'right'
    })
  })

  it('joins the existing next group instead of splitting', () => {
    const moveUnifiedTabToGroup = vi.fn(() => true)
    const focusGroup = vi.fn()
    useAppStore.setState({
      moveUnifiedTabToGroup,
      focusGroup,
      activeGroupIdByWorktree: { [WT]: 'group-1' },
      groupsByWorktree: {
        [WT]: [
          { id: 'group-1', worktreeId: WT, activeTabId: 'tab-a', tabOrder: ['tab-a', 'tab-b'] },
          { id: 'group-2', worktreeId: WT, activeTabId: null, tabOrder: [] }
        ]
      },
      layoutByWorktree: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-1' },
          second: { type: 'leaf', groupId: 'group-2' }
        }
      }
    } as Partial<ReturnType<typeof useAppStore.getState>>)

    expect(moveActiveTabToNextPaneColumn('right')).toBe(true)
    expect(moveUnifiedTabToGroup).toHaveBeenCalledWith('tab-a', 'group-2', { activate: true })
    expect(focusGroup).toHaveBeenCalledWith(WT, 'group-2')
    expect(mocks.mirrorWebRuntimeTabMove).toHaveBeenCalledWith({
      kind: 'move-to-group',
      worktreeId: WT,
      tabId: 'tab-a',
      targetGroupId: 'group-2'
    })
  })

  it('moves a lone tab into the existing next group', () => {
    const moveUnifiedTabToGroup = vi.fn(() => true)
    const focusGroup = vi.fn()
    useAppStore.setState({
      moveUnifiedTabToGroup,
      focusGroup,
      activeGroupIdByWorktree: { [WT]: 'group-1' },
      groupsByWorktree: {
        [WT]: [
          { id: 'group-1', worktreeId: WT, activeTabId: 'tab-a', tabOrder: ['tab-a'] },
          { id: 'group-2', worktreeId: WT, activeTabId: 'tab-b', tabOrder: ['tab-b'] }
        ]
      },
      layoutByWorktree: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-1' },
          second: { type: 'leaf', groupId: 'group-2' }
        }
      }
    } as Partial<ReturnType<typeof useAppStore.getState>>)

    expect(moveActiveTabToNextPaneColumn('right')).toBe(true)
    expect(moveUnifiedTabToGroup).toHaveBeenCalledWith('tab-a', 'group-2', { activate: true })
  })

  it('is a no-op for a lone tab in a lone group', () => {
    const dropUnifiedTab = vi.fn(() => true)
    useAppStore.setState({
      dropUnifiedTab,
      activeGroupIdByWorktree: { [WT]: 'group-1' },
      groupsByWorktree: {
        [WT]: [{ id: 'group-1', worktreeId: WT, activeTabId: 'tab-a', tabOrder: ['tab-a'] }]
      }
    } as Partial<ReturnType<typeof useAppStore.getState>>)

    expect(moveActiveTabToNextPaneColumn('right')).toBe(false)
    expect(dropUnifiedTab).not.toHaveBeenCalled()
  })

  it('falls back to the first layout group when no active group is recorded', () => {
    const dropUnifiedTab = vi.fn(() => true)
    useAppStore.setState({
      dropUnifiedTab,
      activeGroupIdByWorktree: {}
    } as Partial<ReturnType<typeof useAppStore.getState>>)

    expect(moveActiveTabToNextPaneColumn('right')).toBe(true)
    expect(dropUnifiedTab).toHaveBeenCalledWith('tab-a', {
      groupId: 'group-1',
      splitDirection: 'right'
    })
  })

  it('is a no-op without an active worktree', () => {
    const dropUnifiedTab = vi.fn(() => true)
    useAppStore.setState({
      dropUnifiedTab,
      activeWorktreeId: null,
      activeGroupIdByWorktree: {}
    } as Partial<ReturnType<typeof useAppStore.getState>>)

    expect(moveActiveTabToNextPaneColumn('right')).toBe(false)
    expect(dropUnifiedTab).not.toHaveBeenCalled()
  })
})
