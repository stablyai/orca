import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import type { Tab } from '../../../../shared/tab-types'
import {
  moveTabToNewPaneColumn,
  resolveActiveTabPaneColumnMoveTarget,
  resolveTabPaneColumnMoveTarget
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

  it('resolves an executable target once', () => {
    expect(resolveTabPaneColumnMoveTarget(useAppStore.getState(), 'tab-b', 'group-1')).toEqual({
      worktreeId: WT,
      unifiedTabId: 'tab-b',
      groupId: 'group-1'
    })
  })

  it('resolves nothing for the only tab in a group', () => {
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

    expect(resolveTabPaneColumnMoveTarget(useAppStore.getState(), 'tab-a', 'group-1')).toBeNull()
    expect(resolveActiveTabPaneColumnMoveTarget(useAppStore.getState())).toBeNull()
  })

  it('executes a resolved target and mirrors the same worktree', () => {
    const dropUnifiedTab = vi.fn(() => true)
    useAppStore.setState({ dropUnifiedTab } as Partial<ReturnType<typeof useAppStore.getState>>)
    const target = resolveTabPaneColumnMoveTarget(useAppStore.getState(), 'tab-b', 'group-1')
    expect(target).not.toBeNull()

    expect(moveTabToNewPaneColumn({ target: target!, direction: 'right' })).toBe(true)
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

  // Why: activeTabId is a terminal entity id, so active commands resolve through the active group.
  it('resolves the active unified tab', () => {
    useAppStore.setState({ activeGroupIdByWorktree: { [WT]: 'group-1' } })

    expect(resolveActiveTabPaneColumnMoveTarget(useAppStore.getState())).toEqual({
      worktreeId: WT,
      unifiedTabId: 'tab-a',
      groupId: 'group-1'
    })
  })

  it('resolves nothing when the active group has no active tab', () => {
    useAppStore.setState({
      activeGroupIdByWorktree: { [WT]: 'group-1' },
      groupsByWorktree: {
        [WT]: [{ id: 'group-1', worktreeId: WT, activeTabId: null, tabOrder: ['tab-a', 'tab-b'] }]
      }
    })

    expect(resolveActiveTabPaneColumnMoveTarget(useAppStore.getState())).toBeNull()
  })

  it('does not mirror when the local store rejects the move', () => {
    const dropUnifiedTab = vi.fn(() => false)
    useAppStore.setState({ dropUnifiedTab } as Partial<ReturnType<typeof useAppStore.getState>>)
    const target = resolveTabPaneColumnMoveTarget(useAppStore.getState(), 'tab-b', 'group-1')
    expect(target).not.toBeNull()

    expect(moveTabToNewPaneColumn({ target: target!, direction: 'right' })).toBe(false)
    expect(mocks.mirrorWebRuntimeTabMove).not.toHaveBeenCalled()
  })

  it('rejects a target after its tab changes groups', () => {
    const dropUnifiedTab = vi.fn(() => true)
    useAppStore.setState({ dropUnifiedTab } as Partial<ReturnType<typeof useAppStore.getState>>)
    const target = resolveTabPaneColumnMoveTarget(useAppStore.getState(), 'tab-b', 'group-1')
    expect(target).not.toBeNull()

    const tabs = useAppStore.getState().unifiedTabsByWorktree[WT] ?? []
    useAppStore.setState({
      groupsByWorktree: {
        [WT]: [
          {
            id: 'group-1',
            worktreeId: WT,
            activeTabId: 'tab-a',
            tabOrder: ['tab-a']
          },
          {
            id: 'group-2',
            worktreeId: WT,
            activeTabId: 'tab-b',
            tabOrder: ['tab-b']
          }
        ]
      },
      unifiedTabsByWorktree: {
        [WT]: tabs.map((tab) => (tab.id === 'tab-b' ? { ...tab, groupId: 'group-2' } : tab))
      }
    })

    expect(moveTabToNewPaneColumn({ target: target!, direction: 'right' })).toBe(false)
    expect(dropUnifiedTab).not.toHaveBeenCalled()
    expect(mocks.mirrorWebRuntimeTabMove).not.toHaveBeenCalled()
  })
})
