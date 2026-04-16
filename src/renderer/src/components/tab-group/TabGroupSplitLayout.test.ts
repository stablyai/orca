import { describe, expect, it, vi } from 'vitest'

const setTabGroupSplitRatioMock = vi.fn()
const useAppStoreMock = vi.fn(
  (selector: (state: { setTabGroupSplitRatio: () => void }) => unknown) =>
    selector({ setTabGroupSplitRatio: setTabGroupSplitRatioMock })
)
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { setTabGroupSplitRatio: () => void }) => unknown) =>
    useAppStoreMock(selector)
}))

vi.mock('./TabGroupPanel', () => ({
  default: (props: unknown) => ({ __mock: 'TabGroupPanel', props })
}))

vi.mock('./useTabDragSplit', () => ({
  useTabDragSplit: () => ({
    activeDrag: null,
    collisionDetection: vi.fn(),
    hoveredDropTarget: null,
    onDragCancel: vi.fn(),
    onDragEnd: vi.fn(),
    onDragMove: vi.fn(),
    onDragOver: vi.fn(),
    onDragStart: vi.fn(),
    sensors: []
  })
}))

import TabGroupSplitLayout from './TabGroupSplitLayout'

describe('TabGroupSplitLayout', () => {
  function getLeafPanelProps(isWorktreeActive: boolean) {
    const element = TabGroupSplitLayout({
      layout: { type: 'leaf', groupId: 'group-1' },
      worktreeId: 'wt-1',
      focusedGroupId: 'group-1',
      isWorktreeActive
    })

    const splitNodeElement = element.props.children.props.children
    const tabGroupPanelElement = splitNodeElement.type(splitNodeElement.props)
    return tabGroupPanelElement.props as {
      groupId: string
      worktreeId: string
      isFocused: boolean
      hasSplitGroups: boolean
      reserveClosedExplorerToggleSpace: boolean
      reserveCollapsedSidebarHeaderSpace: boolean
    }
  }

  it('does not mark an offscreen worktree group as focused', () => {
    expect(getLeafPanelProps(false)).toEqual(
      expect.objectContaining({
        groupId: 'group-1',
        worktreeId: 'wt-1',
        isFocused: false,
        hasSplitGroups: false,
        reserveClosedExplorerToggleSpace: true,
        reserveCollapsedSidebarHeaderSpace: true
      })
    )
  })

  it('keeps the visible worktree focused group active', () => {
    expect(getLeafPanelProps(true)).toEqual(
      expect.objectContaining({
        groupId: 'group-1',
        worktreeId: 'wt-1',
        isFocused: true,
        hasSplitGroups: false,
        reserveClosedExplorerToggleSpace: true,
        reserveCollapsedSidebarHeaderSpace: true
      })
    )
  })

  it('only reserves top-right header space for the floating explorer toggle', () => {
    const element = TabGroupSplitLayout({
      layout: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: 'left-group' },
        second: { type: 'leaf', groupId: 'right-group' }
      },
      worktreeId: 'wt-1',
      focusedGroupId: 'right-group',
      isWorktreeActive: true
    })

    const splitNodeElement = element.props.children.props.children
    const rootElement = splitNodeElement.type(splitNodeElement.props)
    const leftChild = rootElement.props.children[0].props.children
    const rightChild = rootElement.props.children[2].props.children
    const leftPanelProps = leftChild.type(leftChild.props).props as {
      reserveClosedExplorerToggleSpace: boolean
      reserveCollapsedSidebarHeaderSpace: boolean
    }
    const rightPanelProps = rightChild.type(rightChild.props).props as {
      reserveClosedExplorerToggleSpace: boolean
      reserveCollapsedSidebarHeaderSpace: boolean
    }

    expect(leftPanelProps).toEqual(
      expect.objectContaining({
        reserveClosedExplorerToggleSpace: false,
        reserveCollapsedSidebarHeaderSpace: true
      })
    )
    expect(rightPanelProps).toEqual(
      expect.objectContaining({
        reserveClosedExplorerToggleSpace: true,
        reserveCollapsedSidebarHeaderSpace: false
      })
    )
  })
})
