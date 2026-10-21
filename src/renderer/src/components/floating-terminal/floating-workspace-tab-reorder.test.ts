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
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

vi.mock('../browser-pane/host-guest/webview-registry', () => ({
  acquireWebviewsDragPassthrough: vi.fn(() => vi.fn())
}))

vi.mock('../../runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false)
}))
vi.mock('../../runtime/web-runtime-session-tab-move', () => ({ moveWebRuntimeSessionTab: vi.fn() }))

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

/** The reorder the user sees: a layout-owner build sends it to main, whose frame draws it
 *  (tab-moves-drawn-from-frames.test.ts); otherwise the window reorders the group itself. */
function expectReorder(tabId: string, order: string[]): void {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    expect(layoutApplyTestTransport.sentOfType('moveTab')).toEqual([
      expect.objectContaining({ tabId, toGroupId: GROUP_ID, index: order.indexOf(tabId) })
    ])
  } else {
    expect(floatingTabOrder()).toEqual(order)
  }
}

function floatingTabOrder(): string[] {
  const groups: TabGroup[] =
    useAppStore.getState().groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
  return groups.find((group) => group.id === GROUP_ID)?.tabOrder ?? []
}

beforeEach(() => {
  layoutApplyTestTransport.reset()
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
  it('moves a tab after the hovered tab when released on its right half', async () => {
    dropTab('tab-a', 'tab-c', 290)
    await layoutApplyTestTransport.settle()
    expectReorder('tab-a', ['tab-b', 'tab-c', 'tab-a'])
  })

  it('moves a tab before the hovered tab when released on its left half', async () => {
    dropTab('tab-c', 'tab-a', 210)
    await layoutApplyTestTransport.settle()
    expectReorder('tab-c', ['tab-c', 'tab-a', 'tab-b'])
  })

  it('leaves the order alone when a tab is dropped on itself', async () => {
    dropTab('tab-b', 'tab-b', 290)
    await layoutApplyTestTransport.settle()
    expect(floatingTabOrder()).toEqual(['tab-a', 'tab-b', 'tab-c'])
  })

  it('republishes sortOrder so the panel renders the committed order', async () => {
    dropTab('tab-a', 'tab-c', 290)
    await layoutApplyTestTransport.settle()
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main's frame draws the order, sortOrder included.
      expectReorder('tab-a', ['tab-b', 'tab-c', 'tab-a'])
      return
    }
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
