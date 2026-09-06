import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import type { Tab } from '../../../../shared/tab-types'
import {
  canMoveTabToNewPaneColumn,
  getActiveTabForPaneColumnMove,
  moveActiveTabToNewPaneColumn,
  moveTabToNewPaneColumn
} from './tab-move-to-pane-column'

const WT = 'wt-1'

const mocks = vi.hoisted(() => ({
  mirrorWebRuntimeTabMove: vi.fn()
}))

vi.mock('./web-runtime-tab-move-mirror', () => ({
  mirrorWebRuntimeTabMove: mocks.mirrorWebRuntimeTabMove
}))

function seedTwoTabGroup(): void {
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
}

describe('tab-move-to-pane-column', () => {
  beforeEach(() => {
    mocks.mirrorWebRuntimeTabMove.mockReset()
    seedTwoTabGroup()
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
})

describe('moveActiveTabToNewPaneColumn', () => {
  beforeEach(() => {
    mocks.mirrorWebRuntimeTabMove.mockReset()
    // Why seed here too: a sibling describe's beforeEach does not run for this
    // block, so relying on it left these cases failing under a -t filter.
    seedTwoTabGroup()
    useAppStore.setState({ activeGroupIdByWorktree: { [WT]: 'group-1' } })
  })

  it('resolves the active tab of the active group', () => {
    expect(getActiveTabForPaneColumnMove(useAppStore.getState(), WT)).toEqual({
      unifiedTabId: 'tab-a',
      groupId: 'group-1'
    })
  })

  it('moves the active tab in the requested direction', () => {
    const dropUnifiedTab = vi.fn(() => true)
    useAppStore.setState({ dropUnifiedTab } as Partial<ReturnType<typeof useAppStore.getState>>)

    expect(moveActiveTabToNewPaneColumn('down', WT)).toBe(true)
    expect(dropUnifiedTab).toHaveBeenCalledWith('tab-a', {
      groupId: 'group-1',
      splitDirection: 'down'
    })
  })

  it('does nothing without a worktree, an active group, or a movable tab', () => {
    expect(getActiveTabForPaneColumnMove(useAppStore.getState(), null)).toBeNull()
    expect(moveActiveTabToNewPaneColumn('down', null)).toBe(false)

    useAppStore.setState({ activeGroupIdByWorktree: {} })
    expect(getActiveTabForPaneColumnMove(useAppStore.getState(), WT)).toBeNull()
    expect(moveActiveTabToNewPaneColumn('down', WT)).toBe(false)

    // A lone tab in its group is an unmovable layout, same as the menu case.
    useAppStore.setState({
      activeGroupIdByWorktree: { [WT]: 'group-1' },
      groupsByWorktree: {
        [WT]: [{ id: 'group-1', worktreeId: WT, activeTabId: 'tab-a', tabOrder: ['tab-a'] }]
      }
    })
    expect(moveActiveTabToNewPaneColumn('down', WT)).toBe(false)
  })
})
