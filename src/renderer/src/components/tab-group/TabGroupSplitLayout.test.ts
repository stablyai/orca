import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setTabGroupSplitRatioMock = vi.fn()
const recordFeatureInteractionMock = vi.fn()
const setDragRootNodeMock = vi.fn()
type MockStoreState = {
  recordFeatureInteraction: typeof recordFeatureInteractionMock
  setTabGroupSplitRatio: typeof setTabGroupSplitRatioMock
  groupsByWorktree: Record<string, unknown[]>
  unifiedTabsByWorktree: Record<string, unknown[]>
  settings: Record<string, unknown>
}
const useAppStoreMock = vi.fn((selector: (state: MockStoreState) => unknown) =>
  selector({
    recordFeatureInteraction: recordFeatureInteractionMock,
    setTabGroupSplitRatio: setTabGroupSplitRatioMock,
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    settings: {}
  })
)
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: MockStoreState) => unknown) => useAppStoreMock(selector)
}))

vi.mock('@/lib/pane-manager/client-hosted-browser-row-state', () => ({
  useClientHostedBrowserRows: () => []
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
    // The layout composes WorkspaceTabDragLayer (a render prop) around the chrome wrapper:
    // invoke it to reach TabDragProvider > DndContext > [wrapper, DragOverlay, split overlay].
    const providerElement = asElement(invokeComponent(asElement(element)))
    const dndContext = asElement(providerElement.props.children)
    return React.Children.toArray(dndContext.props.children as React.ReactNode)[0]
  }

  function getSplitNodeElement(element: ReturnType<typeof TabGroupSplitLayout>) {
    const layoutWrapperChildren = React.Children.toArray(
      asElement(getLayoutWrapper(element)).props.children as React.ReactNode
    )
    const splitBody = layoutWrapperChildren[1]
    const treeElement = React.Children.only(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wrapper's split body renders exactly the tree element; props are untyped in this shallow-walk rig.
      asElement(splitBody).props.children as React.ReactNode
    )
    // TabGroupSplitNodeTree renders the recursive SplitNode; invoke both to reach the leaf/split.
    const splitNodeElement = invokeComponent(asElement(treeElement))
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
      isVisible: boolean
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
        isVisible: false,
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
        isVisible: true,
        isFocused: true,
        hasSplitGroups: false,
        reserveClosedExplorerToggleSpace: true,
        reserveCollapsedSidebarHeaderSpace: true
      })
    )
  })

  it('drops the 4px drag band once every strip in the worktree is auto-hidden', () => {
    useAppStoreMock.mockImplementationOnce((selector) =>
      selector({
        recordFeatureInteraction: recordFeatureInteractionMock,
        setTabGroupSplitRatio: setTabGroupSplitRatioMock,
        groupsByWorktree: { 'wt-1': [{ id: 'group-1' }] },
        unifiedTabsByWorktree: { 'wt-1': [{ groupId: 'group-1' }] },
        settings: { autoHideSingleTabStrip: true }
      })
    )
    const element = TabGroupSplitLayout({
      layout: { type: 'leaf', groupId: 'group-1' },
      worktreeId: 'wt-1',
      focusedGroupId: 'group-1',
      isWorktreeActive: true
    })

    const wrapperChildren = React.Children.toArray(
      asElement(getLayoutWrapper(element)).props.children as React.ReactNode
    )

    // Only the split body remains; with the band present there are two children.
    expect(wrapperChildren).toHaveLength(1)
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
})
