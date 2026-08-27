/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import { useTabDragSplit, type TabDragItemData } from '../tab-group/useTabDragSplit'
import { isFloatingTerminalDragTarget } from './floating-terminal-titlebar-drag-target'

vi.mock('../browser-pane/host-guest/webview-registry', () => ({
  acquireWebviewsDragPassthrough: vi.fn(() => vi.fn())
}))

vi.mock('../../runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false),
  moveWebRuntimeSessionTab: vi.fn()
}))

const GROUP_ID = 'floating-group'
const mounted: { container: HTMLDivElement; root: Root }[] = []

function makeTab(id: string, sortOrder: number): Tab {
  return {
    id,
    groupId: GROUP_ID,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    contentType: 'terminal',
    entityId: `term-${id}`,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  }
}

function makeDragData(unifiedTabId: string): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    groupId: GROUP_ID,
    unifiedTabId,
    visibleTabId: `term-${unifiedTabId}`,
    tabType: 'terminal',
    label: unifiedTabId
  }
}

function makeDropEvent(
  activeData: TabDragItemData,
  overData: TabDragItemData | null,
  pointerX: number
) {
  return {
    active: { data: { current: activeData }, rect: { current: { initial: null } } },
    over: overData
      ? {
          id: overData.visibleTabId,
          data: { current: overData },
          // Tabs sit in a 100px-wide strip slot starting at x=200; midpoint is 250.
          rect: { left: 200, top: 0, width: 100, height: 32 }
        }
      : null,
    delta: { x: 0, y: 0 },
    activatorEvent: { clientX: pointerX, clientY: 16 }
  }
}

function renderFloatingDragHook(): ReturnType<typeof useTabDragSplit> {
  let result: ReturnType<typeof useTabDragSplit> | null = null
  function Probe(): null {
    result = useTabDragSplit({ worktreeId: FLOATING_TERMINAL_WORKTREE_ID, enabled: true })
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(createElement(Probe)))
  mounted.push({ container, root })
  if (!result) {
    throw new Error('useTabDragSplit did not render')
  }
  return result
}

function dropTab(from: string, over: string, pointerX: number): void {
  const drag = renderFloatingDragHook()
  const activeData = makeDragData(from)
  act(() => {
    drag.onDragStart(
      makeDropEvent(activeData, null, pointerX) as unknown as Parameters<typeof drag.onDragStart>[0]
    )
  })
  act(() => {
    drag.onDragEnd(
      makeDropEvent(activeData, makeDragData(over), pointerX) as unknown as Parameters<
        typeof drag.onDragEnd
      >[0]
    )
  })
}

function floatingTabOrder(): string[] {
  const groups: TabGroup[] =
    useAppStore.getState().groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
  return groups.find((group) => group.id === GROUP_ID)?.tabOrder ?? []
}

beforeEach(() => {
  useAppStore.setState({
    // The floating workspace is never the active worktree; its tabs still reorder.
    activeWorktreeId: 'wt-main',
    activeGroupIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: GROUP_ID },
    groupsByWorktree: {
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        {
          id: GROUP_ID,
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          activeTabId: 'tab-a',
          tabOrder: ['tab-a', 'tab-b', 'tab-c']
        }
      ]
    },
    unifiedTabsByWorktree: {
      [FLOATING_TERMINAL_WORKTREE_ID]: [
        makeTab('tab-a', 0),
        makeTab('tab-b', 1),
        makeTab('tab-c', 2)
      ]
    },
    layoutByWorktree: {}
  })
})

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('floating workspace tab reorder', () => {
  it('moves a tab after the hovered tab when released on its right half', () => {
    dropTab('tab-a', 'tab-c', 290)
    expect(floatingTabOrder()).toEqual(['tab-b', 'tab-c', 'tab-a'])
  })

  it('moves a tab before the hovered tab when released on its left half', () => {
    dropTab('tab-c', 'tab-a', 210)
    expect(floatingTabOrder()).toEqual(['tab-c', 'tab-a', 'tab-b'])
  })

  it('leaves the order alone when a tab is dropped on itself', () => {
    dropTab('tab-b', 'tab-b', 290)
    expect(floatingTabOrder()).toEqual(['tab-a', 'tab-b', 'tab-c'])
  })

  it('republishes sortOrder so the panel renders the committed order', () => {
    dropTab('tab-a', 'tab-c', 290)
    const tabs = useAppStore.getState().unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
    expect(tabs.map((tab) => [tab.id, tab.sortOrder])).toEqual([
      ['tab-a', 2],
      ['tab-b', 0],
      ['tab-c', 1]
    ])
  })
})

describe('floating panel titlebar drag target', () => {
  it.each(['sortable-tab', 'browser-tab', 'editor-tab', 'client-hosted-browser-row-id'])(
    'does not move the panel when the press lands on a %s',
    (kind) => {
      const tab = document.createElement('div')
      tab.dataset.tabId = kind
      const label = document.createElement('span')
      tab.appendChild(label)
      document.body.appendChild(tab)

      expect(isFloatingTerminalDragTarget(tab)).toBe(false)
      expect(isFloatingTerminalDragTarget(label)).toBe(false)
    }
  )

  it('does not move the panel when a tab SVG icon receives the press', () => {
    const tab = document.createElement('div')
    tab.dataset.tabId = 'terminal-tab'
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    tab.appendChild(icon)
    document.body.appendChild(tab)

    expect(isFloatingTerminalDragTarget(icon)).toBe(false)
  })

  it('still moves the panel from bare titlebar chrome', () => {
    const titlebar = document.createElement('div')
    document.body.appendChild(titlebar)
    expect(isFloatingTerminalDragTarget(titlebar)).toBe(true)
  })
})
