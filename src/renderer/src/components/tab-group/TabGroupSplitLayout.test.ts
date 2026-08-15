/**
 * @vitest-environment happy-dom
 */
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'

const setTabGroupSplitRatioMock = vi.fn()
const recordFeatureInteractionMock = vi.fn()
const setDragRootNodeMock = vi.fn()
const togglePaneZoomMock = vi.fn()
let zoomedGroupIdByWorktree: Record<string, string | null> = {}
let canExpandPaneByTabId: Record<string, boolean> = {}
const useAppStoreMock = vi.fn(
  (
    selector: (state: {
      canExpandPaneByTabId: Record<string, boolean>
      groupsByWorktree: Record<string, { id: string; activeTabId: string | null }[]>
      keybindings: Record<string, string[]>
      recordFeatureInteraction: typeof recordFeatureInteractionMock
      settings: { terminalShortcutPolicy: 'orca-first' }
      setTabGroupSplitRatio: typeof setTabGroupSplitRatioMock
      togglePaneZoom: typeof togglePaneZoomMock
      unifiedTabsByWorktree: Record<
        string,
        { id: string; contentType: 'terminal'; entityId: string }[]
      >
      zoomedGroupIdByWorktree: Record<string, string | null>
    }) => unknown
  ) =>
    selector({
      canExpandPaneByTabId,
      groupsByWorktree: {
        'wt-1': [{ id: 'group-1', activeTabId: 'unified-terminal-1' }]
      },
      keybindings: {},
      recordFeatureInteraction: recordFeatureInteractionMock,
      settings: { terminalShortcutPolicy: 'orca-first' },
      setTabGroupSplitRatio: setTabGroupSplitRatioMock,
      togglePaneZoom: togglePaneZoomMock,
      unifiedTabsByWorktree: {
        'wt-1': [{ id: 'unified-terminal-1', contentType: 'terminal', entityId: 'terminal-1' }]
      },
      zoomedGroupIdByWorktree
    })
)
vi.mock('../../store', () => ({
  useAppStore: (
    selector: (state: {
      canExpandPaneByTabId: Record<string, boolean>
      groupsByWorktree: Record<string, { id: string; activeTabId: string | null }[]>
      keybindings: Record<string, string[]>
      recordFeatureInteraction: typeof recordFeatureInteractionMock
      settings: { terminalShortcutPolicy: 'orca-first' }
      setTabGroupSplitRatio: typeof setTabGroupSplitRatioMock
      togglePaneZoom: typeof togglePaneZoomMock
      unifiedTabsByWorktree: Record<
        string,
        { id: string; contentType: 'terminal'; entityId: string }[]
      >
      zoomedGroupIdByWorktree: Record<string, string | null>
    }) => unknown
  ) => useAppStoreMock(selector)
}))

vi.mock('./TabGroupPanel', () => ({
  default: (props: Record<string, unknown>) => React.createElement('mock-tab-group-panel', props)
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

const mounted: { container: HTMLDivElement; root: Root }[] = []

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
  afterEach(() => {
    for (const { container, root } of mounted.splice(0)) {
      act(() => root.unmount())
      container.remove()
    }
  })

  beforeEach(() => {
    setTabGroupSplitRatioMock.mockClear()
    recordFeatureInteractionMock.mockClear()
    setDragRootNodeMock.mockClear()
    togglePaneZoomMock.mockClear()
    zoomedGroupIdByWorktree = {}
    canExpandPaneByTabId = {}
    useAppStoreMock.mockClear()
  })

  function getLayoutWrapper(element: ReturnType<typeof TabGroupSplitLayout>) {
    const dndContext = asElement(element.props.children)
    return React.Children.toArray(dndContext.props.children as React.ReactNode).find((child) => {
      return asElement(child).props?.ref === setDragRootNodeMock
    })
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

  it('renders only the zoomed group while preserving split-pane context', () => {
    zoomedGroupIdByWorktree = { 'wt-1': 'right-group' }
    const element = TabGroupSplitLayout({
      layout: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.2,
        first: { type: 'leaf', groupId: 'left-group' },
        second: { type: 'leaf', groupId: 'right-group' }
      },
      worktreeId: 'wt-1',
      focusedGroupId: 'right-group',
      isWorktreeActive: true
    })

    const panelProps = asElement(getSplitNodeElement(element)).props as {
      groupId: string
      hasSplitGroups: boolean
      isZoomed: boolean
    }

    expect(panelProps).toEqual(
      expect.objectContaining({
        groupId: 'right-group',
        hasSplitGroups: true,
        isZoomed: true
      })
    )
  })

  it('keeps the shortcut boundary mounted when only the active terminal tab can zoom', () => {
    canExpandPaneByTabId = { 'terminal-1': true }
    const element = TabGroupSplitLayout({
      layout: { type: 'leaf', groupId: 'group-1' },
      worktreeId: 'wt-1',
      focusedGroupId: 'group-1',
      isWorktreeActive: true
    })

    const dndContext = asElement(element.props.children)
    const boundary = React.Children.toArray(dndContext.props.children as React.ReactNode).find(
      (child) => asElement(child).type !== 'div'
    )

    expect(asElement(boundary).props).toEqual(
      expect.objectContaining({
        hasSplits: false,
        focusedGroupId: 'group-1'
      })
    )
  })

  it('dispatches terminal pane zoom when the shortcut fires without group splits', () => {
    canExpandPaneByTabId = { 'terminal-1': true }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mounted.push({ container, root })
    const dispatchedDetails: unknown[] = []
    const onToggle = (event: Event): void => {
      dispatchedDetails.push((event as CustomEvent).detail)
    }
    window.addEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggle)

    act(() => {
      root.render(
        React.createElement(TabGroupSplitLayout, {
          layout: { type: 'leaf', groupId: 'group-1' },
          worktreeId: 'wt-1',
          focusedGroupId: 'group-1',
          isWorktreeActive: true
        })
      )
    })

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          altKey: true,
          ctrlKey: true,
          key: 'Enter',
          bubbles: true,
          cancelable: true
        })
      )
    })
    window.removeEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggle)

    expect(dispatchedDetails).toEqual([{ tabId: 'terminal-1' }])
    expect(togglePaneZoomMock).not.toHaveBeenCalled()
  })
})
