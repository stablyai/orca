/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/types'
import { useAppStore } from '../../store'
import type { TabDragItemData } from './useTabDragSplit'
import {
  canDropTabForPaneColumnSplit,
  canDropTabIntoPaneBody,
  getTabDragActivationDistance,
  TAB_DRAG_ACTIVATION_DISTANCE_PX,
  useTabDragSplit
} from './useTabDragSplit'

vi.mock('../browser-pane/webview-registry', () => ({
  acquireWebviewsDragPassthrough: vi.fn(() => vi.fn())
}))

vi.mock('../../runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false),
  moveWebRuntimeSessionTab: vi.fn()
}))

const WT = 'wt-1'
const mounted: { container: HTMLDivElement; root: Root }[] = []

function makeGroup(id: string, tabOrder: string[]): TabGroup {
  return {
    id,
    worktreeId: WT,
    activeTabId: tabOrder[0] ?? null,
    tabOrder
  }
}

function makeDragData(groupId: string, unifiedTabId = 'tab-1'): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: WT,
    groupId,
    unifiedTabId,
    visibleTabId: unifiedTabId,
    tabType: 'editor',
    label: unifiedTabId
  }
}

function rect({
  left,
  top,
  width,
  height
}: {
  left: number
  top: number
  width: number
  height: number
}): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height
  } as DOMRect
}

function addPanelGeometry(groupId: string, panelRect: DOMRect, bodyRect: DOMRect): HTMLElement {
  const panel = document.createElement('div')
  const body = document.createElement('div')
  body.dataset.tabGroupBodyId = groupId
  body.dataset.worktreeId = WT
  panel.getBoundingClientRect = () => panelRect
  body.getBoundingClientRect = () => bodyRect
  panel.appendChild(body)
  document.body.appendChild(panel)
  return panel
}

function makeDragEvent(activeData: TabDragItemData, pointer: { x: number; y: number }) {
  return {
    active: {
      data: { current: activeData },
      rect: { current: { initial: null } }
    },
    over: null,
    delta: { x: 0, y: 0 },
    activatorEvent: { clientX: pointer.x, clientY: pointer.y }
  }
}

function renderDragHook(): ReturnType<typeof useTabDragSplit> {
  let result: ReturnType<typeof useTabDragSplit> | null = null
  function Probe(): null {
    result = useTabDragSplit({ worktreeId: WT })
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

beforeEach(() => {
  useAppStore.setState({
    activeWorktreeId: WT,
    activeGroupIdByWorktree: { [WT]: 'group-1' },
    groupsByWorktree: {
      [WT]: [makeGroup('group-1', ['tab-1', 'tab-3']), makeGroup('group-2', ['tab-2'])]
    },
    unifiedTabsByWorktree: {
      [WT]: [
        {
          id: 'tab-1',
          groupId: 'group-1',
          worktreeId: WT,
          contentType: 'terminal',
          entityId: 'term-1',
          label: 'one',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        } satisfies Tab,
        {
          id: 'tab-2',
          groupId: 'group-2',
          worktreeId: WT,
          contentType: 'terminal',
          entityId: 'term-2',
          label: 'two',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 1
        } satisfies Tab,
        {
          id: 'tab-3',
          groupId: 'group-1',
          worktreeId: WT,
          contentType: 'terminal',
          entityId: 'term-3',
          label: 'three',
          customLabel: null,
          color: null,
          sortOrder: 2,
          createdAt: 2
        } satisfies Tab
      ]
    },
    layoutByWorktree: {
      [WT]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: 'group-1' },
        second: { type: 'leaf', groupId: 'group-2' }
      } satisfies TabGroupLayoutNode
    }
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

describe('tab drag activation distance', () => {
  it('uses the named threshold for enabled tab drags', () => {
    expect(TAB_DRAG_ACTIVATION_DISTANCE_PX).toBe(12)
    expect(getTabDragActivationDistance(true)).toBe(TAB_DRAG_ACTIVATION_DISTANCE_PX)
  })

  it('keeps enabled tab drags above the old overly-sensitive distance', () => {
    expect(TAB_DRAG_ACTIVATION_DISTANCE_PX).toBeGreaterThan(5)
  })

  it('uses an impossible activation distance when tab dragging is disabled', () => {
    expect(getTabDragActivationDistance(false)).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('canDropTabIntoPaneBody', () => {
  it('rejects pane-body drops that would split a single tab onto itself', () => {
    expect(
      canDropTabIntoPaneBody({
        activeDrag: makeDragData('group-1'),
        groupsByWorktree: { [WT]: [makeGroup('group-1', ['tab-1'])] },
        overGroupId: 'group-1',
        worktreeId: WT
      })
    ).toBe(false)
  })

  it('allows same-group pane-body drops when the group still has other tabs', () => {
    expect(
      canDropTabIntoPaneBody({
        activeDrag: makeDragData('group-1'),
        groupsByWorktree: { [WT]: [makeGroup('group-1', ['tab-1', 'tab-2'])] },
        overGroupId: 'group-1',
        worktreeId: WT
      })
    ).toBe(true)
  })

  it('allows pane-body drops into a different group', () => {
    expect(
      canDropTabIntoPaneBody({
        activeDrag: makeDragData('group-1'),
        groupsByWorktree: {
          [WT]: [makeGroup('group-1', ['tab-1']), makeGroup('group-2', ['tab-2'])]
        },
        overGroupId: 'group-2',
        worktreeId: WT
      })
    ).toBe(true)
  })

  it('rejects tab-on-tab split drops across groups', () => {
    expect(
      canDropTabForPaneColumnSplit({
        activeDrag: makeDragData('group-1'),
        groupsByWorktree: {
          [WT]: [makeGroup('group-1', ['tab-1']), makeGroup('group-2', ['tab-2'])]
        },
        targetGroupId: 'group-2',
        worktreeId: WT
      })
    ).toBe(false)
  })
})

describe('useTabDragSplit', () => {
  it('commits a geometry-only pane split when drag end has no over target', () => {
    addPanelGeometry(
      'group-2',
      rect({ left: 500, top: 0, width: 400, height: 600 }),
      rect({ left: 500, top: 32, width: 400, height: 568 })
    )
    const activeData = makeDragData('group-1')
    const dropUnifiedTab = vi.fn(() => true)
    useAppStore.setState({ dropUnifiedTab } as Partial<ReturnType<typeof useAppStore.getState>>)

    const drag = renderDragHook()

    act(() => {
      drag.onDragStart(
        makeDragEvent(activeData, { x: 880, y: 300 }) as unknown as Parameters<
          typeof drag.onDragStart
        >[0]
      )
    })
    act(() => {
      drag.onDragEnd(
        makeDragEvent(activeData, { x: 880, y: 300 }) as unknown as Parameters<
          typeof drag.onDragEnd
        >[0]
      )
    })

    expect(dropUnifiedTab).toHaveBeenCalledWith('tab-1', {
      groupId: 'group-2',
      splitDirection: 'right'
    })
  })
})
