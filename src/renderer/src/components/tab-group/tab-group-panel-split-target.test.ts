import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabGroup, TabGroupLayoutNode } from '../../../../shared/types'
import type { TabDragItemData } from './useTabDragSplit'
import {
  captureTabGroupPanelGeometrySnapshot,
  findTabGroupPanelUnderPointer,
  resolveActivePaneColumnSplitTarget,
  resolvePanelEdgePaneColumnSplit
} from './tab-group-panel-split-target'
import { TAB_GROUP_TAB_STRIP_HEIGHT_PX } from './tab-drop-zone'

function makeDragData(overrides: Partial<TabDragItemData> = {}): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: 'wt-1',
    groupId: 'group-1',
    unifiedTabId: 'tab-1',
    visibleTabId: 'tab-1',
    tabType: 'terminal',
    label: 'tab-1',
    ...overrides
  }
}

function makeEvent({
  activeData,
  overData = null,
  pointer = { x: 0, y: 0 }
}: {
  activeData: TabDragItemData
  overData?: TabDragItemData | null
  pointer?: { x: number; y: number }
}) {
  return {
    active: { data: { current: activeData } },
    over: overData
      ? {
          data: { current: overData },
          rect: { left: 500, width: 120, top: 0, height: 32 }
        }
      : null,
    delta: { x: 0, y: 0 },
    activatorEvent: { clientX: pointer.x, clientY: pointer.y }
  } as unknown as Parameters<typeof resolveActivePaneColumnSplitTarget>[0]['event']
}

function mockTabGroupRects(panelRect: DOMRect, bodyRect: DOMRect): void {
  vi.stubGlobal('document', {
    querySelector: vi.fn(() => ({
      getBoundingClientRect: () => bodyRect,
      parentElement: {
        getBoundingClientRect: () => panelRect
      }
    })),
    querySelectorAll: vi.fn(() => [
      {
        dataset: {
          tabGroupBodyId: 'group-2',
          worktreeId: 'wt-1'
        }
      }
    ])
  })
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

function mockTabGroupGeometry(
  entries: {
    groupId: string
    panelRect: DOMRect
    bodyRect: DOMRect
    counts?: { panelReads: number; bodyReads: number }
  }[]
): { queryAll: ReturnType<typeof vi.fn> } {
  const bodies = entries.map((entry) => ({
    dataset: {
      tabGroupBodyId: entry.groupId,
      worktreeId: 'wt-1'
    },
    getBoundingClientRect: () => {
      if (entry.counts) {
        entry.counts.bodyReads += 1
      }
      return entry.bodyRect
    },
    parentElement: {
      getBoundingClientRect: () => {
        if (entry.counts) {
          entry.counts.panelReads += 1
        }
        return entry.panelRect
      }
    }
  }))
  const queryAll = vi.fn(() => bodies)
  vi.stubGlobal('document', {
    querySelector: vi.fn((selector: string) => {
      const match = selector.match(/data-tab-group-body-id="([^"]+)"/)
      return bodies.find((body) => body.dataset.tabGroupBodyId === match?.[1]) ?? null
    }),
    querySelectorAll: queryAll
  })
  return { queryAll }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function fourGroupFixture(): {
  counts: { panelReads: number; bodyReads: number }[]
  groupsByWorktree: Record<string, TabGroup[]>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  queryAll: ReturnType<typeof vi.fn>
} {
  const counts = [
    { panelReads: 0, bodyReads: 0 },
    { panelReads: 0, bodyReads: 0 },
    { panelReads: 0, bodyReads: 0 },
    { panelReads: 0, bodyReads: 0 }
  ]
  const { queryAll } = mockTabGroupGeometry([
    {
      groupId: 'group-1',
      panelRect: rect({ left: 0, top: 0, width: 300, height: 600 }),
      bodyRect: rect({
        left: 0,
        top: TAB_GROUP_TAB_STRIP_HEIGHT_PX,
        width: 300,
        height: 600 - TAB_GROUP_TAB_STRIP_HEIGHT_PX
      }),
      counts: counts[0]
    },
    {
      groupId: 'group-2',
      panelRect: rect({ left: 304, top: 0, width: 300, height: 600 }),
      bodyRect: rect({
        left: 304,
        top: TAB_GROUP_TAB_STRIP_HEIGHT_PX,
        width: 300,
        height: 600 - TAB_GROUP_TAB_STRIP_HEIGHT_PX
      }),
      counts: counts[1]
    },
    {
      groupId: 'group-3',
      panelRect: rect({ left: 608, top: 0, width: 300, height: 600 }),
      bodyRect: rect({
        left: 608,
        top: TAB_GROUP_TAB_STRIP_HEIGHT_PX,
        width: 300,
        height: 600 - TAB_GROUP_TAB_STRIP_HEIGHT_PX
      }),
      counts: counts[2]
    },
    {
      groupId: 'group-4',
      panelRect: rect({ left: 912, top: 0, width: 300, height: 600 }),
      bodyRect: rect({
        left: 912,
        top: TAB_GROUP_TAB_STRIP_HEIGHT_PX,
        width: 300,
        height: 600 - TAB_GROUP_TAB_STRIP_HEIGHT_PX
      }),
      counts: counts[3]
    }
  ])

  return {
    counts,
    queryAll,
    groupsByWorktree: {
      'wt-1': [
        { id: 'group-1', worktreeId: 'wt-1', activeTabId: 'tab-1', tabOrder: ['tab-1', 'tab-5'] },
        { id: 'group-2', worktreeId: 'wt-1', activeTabId: 'tab-2', tabOrder: ['tab-2'] },
        { id: 'group-3', worktreeId: 'wt-1', activeTabId: 'tab-3', tabOrder: ['tab-3'] },
        { id: 'group-4', worktreeId: 'wt-1', activeTabId: 'tab-4', tabOrder: ['tab-4'] }
      ]
    },
    layoutByWorktree: {
      'wt-1': {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: 'group-1' },
          second: { type: 'leaf', groupId: 'group-2' }
        },
        second: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: 'group-3' },
          second: { type: 'leaf', groupId: 'group-4' }
        }
      }
    }
  }
}

const horizontalLayout: TabGroupLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  ratio: 0.5,
  first: { type: 'leaf', groupId: 'group-1' },
  second: { type: 'leaf', groupId: 'group-2' }
}

const twoGroupLayout = {
  'wt-1': [
    { id: 'group-1', worktreeId: 'wt-1', activeTabId: 'tab-1', tabOrder: ['tab-1'] },
    { id: 'group-2', worktreeId: 'wt-1', activeTabId: 'tab-2', tabOrder: ['tab-2'] }
  ]
}

const layoutByWorktree = { 'wt-1': horizontalLayout }

describe('resolvePanelEdgePaneColumnSplit', () => {
  const panelRect = {
    left: 500,
    top: 0,
    width: 400,
    height: 600,
    right: 900,
    bottom: 600
  } as DOMRect
  const bodyRect = {
    left: 500,
    top: TAB_GROUP_TAB_STRIP_HEIGHT_PX,
    width: 400,
    height: 600 - TAB_GROUP_TAB_STRIP_HEIGHT_PX,
    right: 900,
    bottom: 600
  } as DOMRect

  beforeEach(() => {
    mockTabGroupRects(panelRect, bodyRect)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns a right-edge split when the pointer is on the outer band', () => {
    expect(
      resolvePanelEdgePaneColumnSplit({
        activeDrag: makeDragData({ groupId: 'group-1' }),
        targetGroupId: 'group-2',
        worktreeId: 'wt-1',
        pointer: { x: 880, y: 300 },
        groupsByWorktree: twoGroupLayout,
        layoutByWorktree
      })
    ).toEqual({ groupId: 'group-2', zone: 'right' })
  })

  it('returns null in the center band so cross-group tab insertion can win', () => {
    expect(
      resolvePanelEdgePaneColumnSplit({
        activeDrag: makeDragData({ groupId: 'group-1' }),
        targetGroupId: 'group-2',
        worktreeId: 'wt-1',
        pointer: { x: 700, y: 300 },
        groupsByWorktree: twoGroupLayout,
        layoutByWorktree
      })
    ).toBeNull()
  })

  it('does not treat the tab strip as a top split edge', () => {
    expect(
      resolvePanelEdgePaneColumnSplit({
        activeDrag: makeDragData({ groupId: 'group-2' }),
        targetGroupId: 'group-1',
        worktreeId: 'wt-1',
        pointer: { x: 650, y: 16 },
        groupsByWorktree: twoGroupLayout,
        layoutByWorktree
      })
    ).toBeNull()
  })

  it('suppresses adjacent sibling split drops that would collapse back to the current layout', () => {
    const group1Panel = {
      left: 0,
      top: 0,
      width: 400,
      height: 600,
      right: 400,
      bottom: 600
    } as DOMRect

    expect(
      resolvePanelEdgePaneColumnSplit({
        activeDrag: makeDragData({ groupId: 'group-2', unifiedTabId: 'tab-2' }),
        targetGroupId: 'group-1',
        worktreeId: 'wt-1',
        pointer: { x: 360, y: 300 },
        groupsByWorktree: twoGroupLayout,
        layoutByWorktree,
        panelRect: group1Panel
      })
    ).toBeNull()
  })

  it('rejects stale panel targets when the pointer has left the panel bounds', () => {
    expect(
      resolvePanelEdgePaneColumnSplit({
        activeDrag: makeDragData({ groupId: 'group-1' }),
        targetGroupId: 'group-2',
        worktreeId: 'wt-1',
        pointer: { x: 499, y: 300 },
        groupsByWorktree: twoGroupLayout,
        layoutByWorktree,
        panelRect
      })
    ).toBeNull()
  })
})

describe('resolveActivePaneColumnSplitTarget', () => {
  const panelRect = {
    left: 500,
    top: 0,
    width: 400,
    height: 600,
    right: 900,
    bottom: 600
  } as DOMRect
  const bodyRect = {
    left: 500,
    top: TAB_GROUP_TAB_STRIP_HEIGHT_PX,
    width: 400,
    height: 600 - TAB_GROUP_TAB_STRIP_HEIGHT_PX,
    right: 900,
    bottom: 600
  } as DOMRect

  beforeEach(() => {
    mockTabGroupRects(panelRect, bodyRect)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves cross-group panel-edge splits without an dnd-kit over target', () => {
    expect(findTabGroupPanelUnderPointer('wt-1', { x: 880, y: 300 })?.groupId).toBe('group-2')
    expect(
      resolveActivePaneColumnSplitTarget({
        event: makeEvent({
          activeData: makeDragData({ groupId: 'group-1' }),
          overData: null,
          pointer: { x: 880, y: 300 }
        }),
        groupsByWorktree: twoGroupLayout,
        layoutByWorktree,
        worktreeId: 'wt-1',
        getDragPointer: () => ({ x: 880, y: 300 })
      })
    ).toEqual(expect.objectContaining({ groupId: 'group-2', zone: 'right' }))
  })

  it('skips pane-edge splits for cross-group tab-strip hovers', () => {
    expect(
      resolveActivePaneColumnSplitTarget({
        event: makeEvent({
          activeData: makeDragData({ groupId: 'group-2', unifiedTabId: 'tab-2' }),
          overData: makeDragData({
            groupId: 'group-1',
            unifiedTabId: 'tab-1',
            visibleTabId: 'tab-1'
          }),
          pointer: { x: 650, y: 16 }
        }),
        groupsByWorktree: twoGroupLayout,
        layoutByWorktree,
        worktreeId: 'wt-1',
        getDragPointer: () => ({ x: 650, y: 16 })
      })
    ).toBeNull()
  })

  it('resolves body-edge splits when a stale cross-group tab hover remains active', () => {
    expect(
      resolveActivePaneColumnSplitTarget({
        event: makeEvent({
          activeData: makeDragData({ groupId: 'group-1' }),
          overData: makeDragData({
            groupId: 'group-2',
            unifiedTabId: 'tab-2',
            visibleTabId: 'tab-2'
          }),
          pointer: { x: 880, y: 300 }
        }),
        groupsByWorktree: twoGroupLayout,
        layoutByWorktree,
        worktreeId: 'wt-1',
        getDragPointer: () => ({ x: 880, y: 300 })
      })
    ).toEqual(expect.objectContaining({ groupId: 'group-2', zone: 'right' }))
  })

  it('ignores stale over targets after the pointer leaves the cached panel', () => {
    const geometry = {
      entries: [
        {
          groupId: 'group-2',
          panelRect,
          bodyRect
        }
      ],
      byGroupId: new Map([['group-2', { groupId: 'group-2', panelRect, bodyRect }]])
    }

    expect(
      resolveActivePaneColumnSplitTarget({
        event: makeEvent({
          activeData: makeDragData({ groupId: 'group-1' }),
          overData: makeDragData({
            groupId: 'group-2',
            unifiedTabId: 'tab-2',
            visibleTabId: 'tab-2'
          }),
          pointer: { x: 499, y: 300 }
        }),
        groupsByWorktree: twoGroupLayout,
        layoutByWorktree,
        worktreeId: 'wt-1',
        getDragPointer: () => ({ x: 499, y: 300 }),
        geometry
      })
    ).toBeNull()
  })

  it('does not create a split target while hovering over another tab in the same strip', () => {
    const panelRect = rect({ left: 500, top: 0, width: 400, height: 600 })
    mockTabGroupGeometry([
      {
        groupId: 'group-1',
        panelRect,
        bodyRect: rect({
          left: 500,
          top: TAB_GROUP_TAB_STRIP_HEIGHT_PX,
          width: 400,
          height: 600 - TAB_GROUP_TAB_STRIP_HEIGHT_PX
        })
      }
    ])
    const geometry = captureTabGroupPanelGeometrySnapshot('wt-1')

    expect(
      resolveActivePaneColumnSplitTarget({
        event: makeEvent({
          activeData: makeDragData({ groupId: 'group-1', unifiedTabId: 'tab-1' }),
          overData: makeDragData({
            groupId: 'group-1',
            unifiedTabId: 'tab-2',
            visibleTabId: 'tab-2'
          }),
          pointer: { x: 560, y: 16 }
        }),
        groupsByWorktree: {
          'wt-1': [
            {
              id: 'group-1',
              worktreeId: 'wt-1',
              activeTabId: 'tab-1',
              tabOrder: ['tab-1', 'tab-2']
            }
          ]
        },
        layoutByWorktree: {
          'wt-1': { type: 'leaf', groupId: 'group-1' }
        },
        worktreeId: 'wt-1',
        getDragPointer: () => ({ x: 560, y: 16 }),
        geometry
      })
    ).toBeNull()
  })

  it('ignores same-group tab hovers after the pointer leaves the panel', () => {
    const panelRect = rect({ left: 500, top: 0, width: 400, height: 600 })
    mockTabGroupGeometry([
      {
        groupId: 'group-1',
        panelRect,
        bodyRect: rect({
          left: 500,
          top: TAB_GROUP_TAB_STRIP_HEIGHT_PX,
          width: 400,
          height: 600 - TAB_GROUP_TAB_STRIP_HEIGHT_PX
        })
      }
    ])
    const geometry = captureTabGroupPanelGeometrySnapshot('wt-1')

    expect(
      resolveActivePaneColumnSplitTarget({
        event: makeEvent({
          activeData: makeDragData({ groupId: 'group-1', unifiedTabId: 'tab-1' }),
          overData: makeDragData({
            groupId: 'group-1',
            unifiedTabId: 'tab-2',
            visibleTabId: 'tab-2'
          }),
          pointer: { x: 560, y: 601 }
        }),
        groupsByWorktree: {
          'wt-1': [
            {
              id: 'group-1',
              worktreeId: 'wt-1',
              activeTabId: 'tab-1',
              tabOrder: ['tab-1', 'tab-2']
            }
          ]
        },
        layoutByWorktree: {
          'wt-1': { type: 'leaf', groupId: 'group-1' }
        },
        worktreeId: 'wt-1',
        getDragPointer: () => ({ x: 560, y: 601 }),
        geometry
      })
    ).toBeNull()
  })

  it('reuses one geometry snapshot across drag frames instead of measuring layout per move', () => {
    const {
      counts,
      groupsByWorktree,
      layoutByWorktree: fourGroupLayoutByWorktree,
      queryAll
    } = fourGroupFixture()
    const geometry = captureTabGroupPanelGeometrySnapshot('wt-1')

    const points = [
      { x: 295, y: 300 },
      { x: 360, y: 300 },
      { x: 595, y: 300 },
      { x: 664, y: 300 },
      { x: 899, y: 300 },
      { x: 968, y: 300 },
      { x: 1204, y: 300 }
    ]
    for (const pointer of points) {
      resolveActivePaneColumnSplitTarget({
        event: makeEvent({
          activeData: makeDragData({ groupId: 'group-1' }),
          overData: null,
          pointer
        }),
        groupsByWorktree,
        layoutByWorktree: fourGroupLayoutByWorktree,
        worktreeId: 'wt-1',
        getDragPointer: () => pointer,
        geometry
      })
    }

    expect(queryAll).toHaveBeenCalledTimes(1)
    expect(counts.reduce((sum, entry) => sum + entry.panelReads + entry.bodyReads, 0)).toBe(8)
  })

  it('reports cached split-target resolution timing without gating CI on wall-clock time', () => {
    const {
      counts,
      groupsByWorktree,
      layoutByWorktree: fourGroupLayoutByWorktree,
      queryAll
    } = fourGroupFixture()
    const geometry = captureTabGroupPanelGeometrySnapshot('wt-1')
    const points = [
      { x: 295, y: 300 },
      { x: 360, y: 300 },
      { x: 595, y: 300 },
      { x: 664, y: 300 },
      { x: 899, y: 300 },
      { x: 968, y: 300 },
      { x: 1204, y: 300 },
      { x: 650, y: 300 }
    ]
    const durations: number[] = []
    for (let index = 0; index < 1_000; index += 1) {
      const pointer = points[index % points.length]!
      const startedAt = performance.now()
      resolveActivePaneColumnSplitTarget({
        event: makeEvent({
          activeData: makeDragData({ groupId: 'group-1' }),
          overData: null,
          pointer
        }),
        groupsByWorktree,
        layoutByWorktree: fourGroupLayoutByWorktree,
        worktreeId: 'wt-1',
        getDragPointer: () => pointer,
        geometry
      })
      durations.push(performance.now() - startedAt)
    }

    const p95Ms = percentile(durations, 0.95)
    const maxMs = Math.max(...durations)
    console.info(
      `tab split preview resolver perf: p95=${p95Ms.toFixed(3)}ms max=${maxMs.toFixed(
        3
      )}ms samples=${durations.length}`
    )
    expect(queryAll).toHaveBeenCalledTimes(1)
    expect(counts.reduce((sum, entry) => sum + entry.panelReads + entry.bodyReads, 0)).toBe(8)
  })
})
