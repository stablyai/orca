import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setTabGroupSplitRatioMock = vi.fn()
const recordFeatureInteractionMock = vi.fn()
const setDragRootNodeMock = vi.fn()
const useAppStoreMock = vi.fn(
  (
    selector: (state: {
      recordFeatureInteraction: typeof recordFeatureInteractionMock
      setTabGroupSplitRatio: typeof setTabGroupSplitRatioMock
    }) => unknown
  ) =>
    selector({
      recordFeatureInteraction: recordFeatureInteractionMock,
      setTabGroupSplitRatio: setTabGroupSplitRatioMock
    })
)
vi.mock('../../store', () => ({
  useAppStore: (
    selector: (state: {
      recordFeatureInteraction: typeof recordFeatureInteractionMock
      setTabGroupSplitRatio: typeof setTabGroupSplitRatioMock
    }) => unknown
  ) => useAppStoreMock(selector)
}))

vi.mock('./TabGroupPanel', () => ({
  default: (props: unknown) => ({ __mock: 'TabGroupPanel', props })
}))

vi.mock('./useTabDragSplit', () => ({
  useTabDragSplit: () => ({
    activeDrag: null,
    collisionDetection: vi.fn(),
    hoveredDropTarget: null,
    hoveredTabInsertion: null,
    isTabDragActiveRef: { current: false },
    onDragCancel: vi.fn(),
    onDragEnd: vi.fn(),
    onDragMove: vi.fn(),
    onDragOver: vi.fn(),
    onDragStart: vi.fn(),
    sensors: [],
    setDragRootNode: setDragRootNodeMock
  })
}))

import TabGroupSplitLayout from './TabGroupSplitLayout'

type ReactElementLike = {
  type: string | ((props: Record<string, unknown>) => unknown)
  props: Record<string, unknown>
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike
}

function invokeComponent(element: ReactElementLike): unknown {
  if (typeof element.type === 'function') {
    return element.type(element.props)
  }
  return element
}

describe('TabGroupSplitLayout', () => {
  beforeEach(() => {
    setTabGroupSplitRatioMock.mockClear()
    recordFeatureInteractionMock.mockClear()
    setDragRootNodeMock.mockClear()
    useAppStoreMock.mockClear()
  })

  function getLayoutWrapper(element: ReturnType<typeof TabGroupSplitLayout>) {
    const dndContext = asElement(element.props.children)
    return React.Children.toArray(dndContext.props.children as React.ReactNode)[0]
  }

  function getSplitNodeElement(element: ReturnType<typeof TabGroupSplitLayout>) {
    const layoutWrapperChildren = React.Children.toArray(
      asElement(getLayoutWrapper(element)).props.children as React.ReactNode
    )
    const splitBody = layoutWrapperChildren[1]
    const splitNodeElement = React.Children.only(
      asElement(splitBody).props.children as React.ReactNode
    )
    return invokeComponent(asElement(splitNodeElement))
  }

  function getLeafPanelProps(isWorktreeActive: boolean) {
    const element = TabGroupSplitLayout({
      layout: { type: 'leaf', groupId: 'group-1' },
      worktreeId: 'wt-1',
      focusedGroupId: 'group-1',
      isWorktreeActive
    })

    const tabGroupPanelElement = asElement(getSplitNodeElement(element))
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

  it('wires the split layout root to drag cleanup ownership', () => {
    const element = TabGroupSplitLayout({
      layout: { type: 'leaf', groupId: 'group-1' },
      worktreeId: 'wt-1',
      focusedGroupId: 'group-1',
      isWorktreeActive: true
    })

    expect(asElement(getLayoutWrapper(element)).props.ref).toBe(setDragRootNodeMock)
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

    const rootElement = asElement(getSplitNodeElement(element))
    const rootChildren = rootElement.props.children as unknown[]
    const leftChild = asElement(rootChildren[0]).props.children
    const rightChild = asElement(rootChildren[2]).props.children
    const leftPanelProps = asElement(invokeComponent(asElement(leftChild))).props as {
      reserveClosedExplorerToggleSpace: boolean
      reserveCollapsedSidebarHeaderSpace: boolean
    }
    const rightPanelProps = asElement(invokeComponent(asElement(rightChild))).props as {
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

  it('records pane resizing at the start of the gesture', () => {
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

    const rootElement = asElement(getSplitNodeElement(element))
    const resizeHandle = asElement((rootElement.props.children as unknown[])[1])

    ;(resizeHandle.props.onResizeStart as () => void)()

    expect(recordFeatureInteractionMock).toHaveBeenCalledWith('terminal-panes')
  })
})
