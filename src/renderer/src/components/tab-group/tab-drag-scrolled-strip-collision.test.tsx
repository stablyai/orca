/**
 * @vitest-environment happy-dom
 *
 * Two splits side by side whose tab strips overflow and scroll. dnd-kit measures each tab with
 * getBoundingClientRect, which ignores the strip's overflow clip, so scrolled-off tabs keep rects
 * over the other split or the strip's own buttons. Drops must follow what the user sees.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type {
  Active,
  ClientRect,
  DragMoveEvent,
  DroppableContainer,
  Over,
  UniqueIdentifier
} from '@dnd-kit/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { useAppStore } from '../../store'
import { recordTabDragPointer } from './tab-drag-pointer'
import { getTabPaneBodyDroppableId, useTabDragSplit, type TabDragItemData } from './useTabDragSplit'

vi.mock('../../runtime/web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false)
}))
vi.mock('../../runtime/web-session-tabs-sync/actions/web-runtime-session-tab-move', () => ({
  moveWebRuntimeSessionTab: vi.fn()
}))

const WT = 'folder:owner-layout'
const LEFT = 'left-group'
const RIGHT = 'right-group'
const STRIP_HEIGHT = 32
const PANEL_HEIGHT = 900
const STRIP_Y = STRIP_HEIGHT / 2

type SplitSpec = {
  groupId: string
  panelLeft: number
  panelWidth: number
  /** The scroller ends before the strip's own buttons. */
  scrollerWidth: number
  tabWidth: number
  tabIds: string[]
  scrollLeft: number
}

type Layout = {
  containers: DroppableContainer[]
  rects: Map<UniqueIdentifier, ClientRect>
}

const mounted: { container: HTMLDivElement; root: Root }[] = []

function rect(left: number, top: number, width: number, height: number): ClientRect {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

function stubRect(element: HTMLElement, box: ClientRect): void {
  element.getBoundingClientRect = () => new DOMRect(box.left, box.top, box.width, box.height)
}

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`)
}

function isChat(id: string): boolean {
  return id.startsWith('structured-agent-session')
}

function tabData(groupId: string, id: string): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: WT,
    groupId,
    unifiedTabId: id,
    visibleTabId: id,
    tabType: isChat(id) ? 'agent-session' : 'browser',
    label: id
  }
}

function unifiedTab(groupId: string, id: string, sortOrder: number): Tab {
  return {
    id,
    groupId,
    worktreeId: WT,
    contentType: isChat(id) ? 'agent-session' : 'browser',
    entityId: id,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: 0
  }
}

function droppable(
  id: UniqueIdentifier,
  data: Record<string, unknown>,
  node: HTMLElement
): DroppableContainer {
  return {
    id,
    key: String(id),
    data: { current: data },
    disabled: false,
    node: { current: node },
    rect: { current: null }
  }
}

/** Mounts each split as TabGroupPanel renders it and returns the rects dnd-kit would measure. */
function mountSplits(splits: [SplitSpec, SplitSpec]): Layout {
  const containers: DroppableContainer[] = []
  const rects = new Map<UniqueIdentifier, ClientRect>()
  for (const split of splits) {
    const panel = document.createElement('div')
    const scroller = document.createElement('div')
    scroller.setAttribute('data-tab-strip-scroller', '')
    stubRect(scroller, rect(split.panelLeft, 0, split.scrollerWidth, STRIP_HEIGHT))
    panel.appendChild(scroller)
    split.tabIds.forEach((id, index) => {
      const node = document.createElement('div')
      scroller.appendChild(node)
      containers.push(droppable(id, tabData(split.groupId, id), node))
      rects.set(
        id,
        rect(
          split.panelLeft + index * split.tabWidth - split.scrollLeft,
          0,
          split.tabWidth,
          STRIP_HEIGHT
        )
      )
    })
    const body = document.createElement('div')
    body.dataset.tabGroupBodyId = split.groupId
    body.dataset.worktreeId = WT
    const bodyRect = rect(
      split.panelLeft,
      STRIP_HEIGHT,
      split.panelWidth,
      PANEL_HEIGHT - STRIP_HEIGHT
    )
    stubRect(body, bodyRect)
    stubRect(panel, rect(split.panelLeft, 0, split.panelWidth, PANEL_HEIGHT))
    panel.appendChild(body)
    document.body.appendChild(panel)
    const bodyId = getTabPaneBodyDroppableId(split.groupId)
    containers.push(
      droppable(bodyId, { kind: 'pane-body', worktreeId: WT, groupId: split.groupId }, body)
    )
    rects.set(bodyId, bodyRect)
  }

  useAppStore.setState({
    activeWorktreeId: WT,
    activeGroupIdByWorktree: { [WT]: splits[0].groupId },
    groupsByWorktree: {
      [WT]: splits.map((split) => ({
        id: split.groupId,
        worktreeId: WT,
        activeTabId: split.tabIds.at(-1)!,
        tabOrder: [...split.tabIds]
      }))
    },
    layoutByWorktree: {
      [WT]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: splits[0].groupId },
        second: { type: 'leaf', groupId: splits[1].groupId },
        ratio: 0.48
      }
    },
    unifiedTabsByWorktree: {
      [WT]: splits.flatMap((split) =>
        split.tabIds.map((id, index) => unifiedTab(split.groupId, id, index))
      )
    }
  })
  return { containers, rects }
}

function renderDragHook(): () => ReturnType<typeof useTabDragSplit> {
  let latest: ReturnType<typeof useTabDragSplit> | null = null
  function Probe(): null {
    latest = useTabDragSplit({ worktreeId: WT })
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(createElement(Probe)))
  mounted.push({ container: host, root })
  return () => {
    if (!latest) {
      throw new Error('useTabDragSplit did not render')
    }
    return latest
  }
}

/** Drag a tab to a point the way dnd-kit does: resolve collisions, report a move, then drop. */
function dragTab(args: {
  layout: Layout
  groupId: string
  tabId: string
  pointer: { x: number; y: number }
  /** Where the dragged ghost's centre sits relative to the pointer. */
  grabOffsetX?: number
}): { insertionTabId: string | null } {
  const drag = renderDragHook()
  const activeRect = args.layout.rects.get(args.tabId)!
  const active: Active = {
    id: args.tabId,
    data: { current: tabData(args.groupId, args.tabId) },
    rect: { current: { initial: activeRect, translated: activeRect } }
  }
  const activatorEvent = new Event('pointerdown')
  act(() => drag().onDragStart({ active, activatorEvent }))
  const centerX = args.pointer.x + (args.grabOffsetX ?? 0)
  const collisions = drag().collisionDetection({
    active,
    collisionRect: rect(centerX - activeRect.width / 2, 0, activeRect.width, STRIP_HEIGHT),
    droppableRects: args.layout.rects,
    droppableContainers: args.layout.containers,
    pointerCoordinates: args.pointer
  })
  const overId = collisions[0]?.id
  const overDroppable = args.layout.containers.find((candidate) => candidate.id === overId)
  // dnd-kit reports `over` with the rect it measured, not a clipped one.
  const over: Over | null =
    overId !== undefined && overDroppable
      ? {
          id: overId,
          rect: args.layout.rects.get(overId)!,
          data: overDroppable.data,
          disabled: false
        }
      : null
  const event: DragMoveEvent = { active, over, delta: { x: 0, y: 0 }, activatorEvent, collisions }
  recordTabDragPointer(args.pointer)
  act(() => drag().onDragMove(event))
  const insertionTabId = drag().hoveredTabInsertion?.visibleTabId ?? null
  act(() => drag().onDragEnd(event))
  return { insertionTabId }
}

function tabOrder(groupId: string): string[] | undefined {
  return useAppStore.getState().groupsByWorktree[WT]?.find((group) => group.id === groupId)
    ?.tabOrder
}

afterEach(() => {
  recordTabDragPointer(null)
  for (const { container: host, root } of mounted.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  document.body.replaceChildren()
})

const CHAT_IDS = ['a', 'b', 'c', 'd', 'e'].map((id) => `structured-agent-session-${id}`)
const OWNER_RIGHT_IDS = ids('right-tab', 26)
// The owner's layout: five chats on the left; 26 tabs on the right, scrolled to the last one.
const OWNER_LEFT: SplitSpec = {
  groupId: LEFT,
  panelLeft: 0,
  panelWidth: 760,
  scrollerWidth: 700,
  tabWidth: 140,
  tabIds: CHAT_IDS,
  scrollLeft: 0
}
const OWNER_RIGHT: SplitSpec = {
  groupId: RIGHT,
  panelLeft: 764,
  panelWidth: 836,
  scrollerWidth: 760,
  tabWidth: 120,
  tabIds: OWNER_RIGHT_IDS,
  scrollLeft: 26 * 120 - 760
}

describe('tab drops beside a scrolled tab strip', () => {
  it('reorders a chat within its split when a scrolled-off tab of the other split lies under the pointer', () => {
    const layout = mountSplits([OWNER_LEFT, OWNER_RIGHT])
    // Right half of the third chat: "move the first chat after the third".
    const { insertionTabId } = dragTab({
      layout,
      groupId: LEFT,
      tabId: CHAT_IDS[0]!,
      pointer: { x: 2 * 140 + 100, y: STRIP_Y }
    })

    expect(insertionTabId).toBe('structured-agent-session-c')
    expect(tabOrder(LEFT)).toEqual([
      'structured-agent-session-b',
      'structured-agent-session-c',
      'structured-agent-session-a',
      'structured-agent-session-d',
      'structured-agent-session-e'
    ])
    expect(tabOrder(RIGHT)).toEqual(OWNER_RIGHT_IDS)
  })

  it('never marks a hidden tab of the same split, even over that strip’s own buttons', () => {
    const leftIds = ids('left-tab', 8)
    // The scroller spans 0..640 and the strip's buttons follow; tab 5 (700..840) is out of view.
    const layout = mountSplits([
      { ...OWNER_LEFT, scrollerWidth: 640, tabIds: leftIds },
      { ...OWNER_RIGHT, tabIds: ids('right-tab', 3), scrollLeft: 0 }
    ])
    const { insertionTabId } = dragTab({
      layout,
      groupId: LEFT,
      tabId: leftIds[0]!,
      pointer: { x: 720, y: STRIP_Y }
    })

    expect(insertionTabId).toBe('left-tab-4')
    expect(tabOrder(LEFT)).toEqual([
      'left-tab-1',
      'left-tab-2',
      'left-tab-3',
      'left-tab-4',
      'left-tab-0',
      'left-tab-5',
      'left-tab-6',
      'left-tab-7'
    ])
  })

  it('drops into the strip gap after the last tab of the split under the pointer', () => {
    const rightIds = ids('right-tab', 3)
    const layout = mountSplits([
      { ...OWNER_LEFT, tabIds: CHAT_IDS.slice(0, 3) },
      { ...OWNER_RIGHT, tabIds: rightIds, scrollLeft: 0 }
    ])
    // Grabbed near its left edge, the ghost's centre sits right of the pointer, nearer the other split.
    dragTab({
      layout,
      groupId: LEFT,
      tabId: CHAT_IDS[0]!,
      pointer: { x: 600, y: STRIP_Y },
      grabOffsetX: 60
    })

    expect(tabOrder(LEFT)).toEqual([
      'structured-agent-session-b',
      'structured-agent-session-c',
      'structured-agent-session-a'
    ])
    expect(tabOrder(RIGHT)).toEqual(rightIds)
  })

  it('reorders within the right split when the left strip overflows over it', () => {
    const leftIds = ids('left-tab', 12)
    const rightIds = ids('right-tab', 4)
    // The left strip is unscrolled, so its overflowing tabs (hidden tab 10 is 1000..1100) lie over the right strip.
    const layout = mountSplits([
      { ...OWNER_LEFT, tabWidth: 100, tabIds: leftIds },
      { ...OWNER_RIGHT, tabIds: rightIds, scrollLeft: 0 }
    ])
    // Right half of right tab 2 (1004..1124): "move right tab 0 after right tab 2".
    dragTab({
      layout,
      groupId: RIGHT,
      tabId: rightIds[0]!,
      pointer: { x: 1070, y: STRIP_Y }
    })

    expect(tabOrder(RIGHT)).toEqual(['right-tab-1', 'right-tab-2', 'right-tab-0', 'right-tab-3'])
    expect(tabOrder(LEFT)).toEqual(leftIds)
  })

  it('still moves a tab into the other split when dropped on that split’s tab', () => {
    const rightIds = ids('right-tab', 3)
    const layout = mountSplits([OWNER_LEFT, { ...OWNER_RIGHT, tabIds: rightIds, scrollLeft: 0 }])
    // Left half of right tab 1 (884..1004).
    dragTab({
      layout,
      groupId: LEFT,
      tabId: CHAT_IDS[0]!,
      pointer: { x: 884 + 20, y: STRIP_Y }
    })

    expect(tabOrder(LEFT)).toEqual(CHAT_IDS.slice(1))
    expect(tabOrder(RIGHT)).toEqual(['right-tab-0', CHAT_IDS[0], 'right-tab-1', 'right-tab-2'])
  })
})
