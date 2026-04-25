import { describe, expect, it } from 'vitest'
import {
  resolveTabIndicatorEdges,
  resolveTabInsertion,
  type HoveredTabInsertion
} from './tab-insertion'
import type { TabDragItemData } from './useTabDragSplit'

// ---------------------------------------------------------------------------
// Helpers for building minimal dnd-kit-shaped event stubs
// ---------------------------------------------------------------------------

function makeDragData(overrides: Partial<TabDragItemData> = {}): TabDragItemData {
  return {
    kind: 'tab',
    worktreeId: 'wt-1',
    groupId: 'group-1',
    unifiedTabId: 'tab-active',
    visibleTabId: 'tab-active',
    tabType: 'editor',
    label: 'file.ts',
    ...overrides
  }
}

function isTabDragData(value: unknown): value is TabDragItemData {
  return Boolean(value) && typeof value === 'object' && (value as TabDragItemData).kind === 'tab'
}

/** Build a minimal event stub satisfying the fields `resolveTabInsertion` reads. */
function makeDragEvent({
  activeData,
  overData,
  overRect
}: {
  activeData: TabDragItemData | null
  overData: TabDragItemData | null
  overRect?: { left: number; width: number }
}) {
  return {
    active: { data: { current: activeData } },
    over: overData
      ? {
          data: { current: overData },
          rect: { left: overRect?.left ?? 0, width: overRect?.width ?? 100 }
        }
      : null,
    delta: { x: 0, y: 0 }
  } as unknown as Parameters<typeof resolveTabInsertion>[0]
}

// ---------------------------------------------------------------------------
// resolveTabInsertion
// ---------------------------------------------------------------------------

describe('resolveTabInsertion', () => {
  it('returns null when there is no "over" element', () => {
    const event = makeDragEvent({ activeData: makeDragData(), overData: null })
    expect(resolveTabInsertion(event, isTabDragData, () => ({ x: 50, y: 10 }))).toBeNull()
  })

  it('returns null when active data is not tab drag data', () => {
    const event = makeDragEvent({
      activeData: null,
      overData: makeDragData({ unifiedTabId: 'tab-over', visibleTabId: 'tab-over' })
    })
    expect(resolveTabInsertion(event, isTabDragData, () => ({ x: 50, y: 10 }))).toBeNull()
  })

  it('returns null when over data is not tab drag data', () => {
    const event = {
      active: { data: { current: makeDragData() } },
      over: { data: { current: { kind: 'pane-body' } }, rect: { left: 0, width: 100 } },
      delta: { x: 0, y: 0 }
    } as unknown as Parameters<typeof resolveTabInsertion>[0]
    expect(resolveTabInsertion(event, isTabDragData, () => ({ x: 50, y: 10 }))).toBeNull()
  })

  it('returns null when dragging a tab onto itself', () => {
    const data = makeDragData({ unifiedTabId: 'same-tab', visibleTabId: 'same-tab' })
    const event = makeDragEvent({ activeData: data, overData: data })
    expect(resolveTabInsertion(event, isTabDragData, () => ({ x: 50, y: 10 }))).toBeNull()
  })

  it('returns null when getDragCenter returns null', () => {
    const event = makeDragEvent({
      activeData: makeDragData({ unifiedTabId: 'tab-a' }),
      overData: makeDragData({ unifiedTabId: 'tab-b', visibleTabId: 'tab-b', groupId: 'group-2' })
    })
    expect(resolveTabInsertion(event, isTabDragData, () => null)).toBeNull()
  })

  it('returns side "left" when cursor center is left of the over midpoint', () => {
    const overData = makeDragData({
      unifiedTabId: 'tab-over',
      visibleTabId: 'tab-over',
      groupId: 'group-2'
    })
    // Over rect: left=100, width=100 → midpoint=150
    const event = makeDragEvent({
      activeData: makeDragData({ unifiedTabId: 'tab-active' }),
      overData,
      overRect: { left: 100, width: 100 }
    })
    // Cursor at x=120, which is left of midpoint 150
    const result = resolveTabInsertion(event, isTabDragData, () => ({ x: 120, y: 10 }))
    expect(result).toEqual({
      groupId: 'group-2',
      visibleTabId: 'tab-over',
      side: 'left'
    })
  })

  it('returns side "right" when cursor center is right of the over midpoint', () => {
    const overData = makeDragData({
      unifiedTabId: 'tab-over',
      visibleTabId: 'tab-over',
      groupId: 'group-2'
    })
    // Over rect: left=100, width=100 → midpoint=150
    const event = makeDragEvent({
      activeData: makeDragData({ unifiedTabId: 'tab-active' }),
      overData,
      overRect: { left: 100, width: 100 }
    })
    // Cursor at x=180, which is right of midpoint 150
    const result = resolveTabInsertion(event, isTabDragData, () => ({ x: 180, y: 10 }))
    expect(result).toEqual({
      groupId: 'group-2',
      visibleTabId: 'tab-over',
      side: 'right'
    })
  })

  it('returns side "right" when cursor is exactly at the midpoint', () => {
    const overData = makeDragData({
      unifiedTabId: 'tab-over',
      visibleTabId: 'tab-over',
      groupId: 'group-2'
    })
    // Over rect: left=0, width=200 → midpoint=100
    const event = makeDragEvent({
      activeData: makeDragData({ unifiedTabId: 'tab-active' }),
      overData,
      overRect: { left: 0, width: 200 }
    })
    // Cursor at x=100 — exactly at midpoint, not < midpoint so → 'right'
    const result = resolveTabInsertion(event, isTabDragData, () => ({ x: 100, y: 10 }))
    expect(result).toEqual({
      groupId: 'group-2',
      visibleTabId: 'tab-over',
      side: 'right'
    })
  })
})

// ---------------------------------------------------------------------------
// resolveTabIndicatorEdges
// ---------------------------------------------------------------------------

describe('resolveTabIndicatorEdges', () => {
  it('marks both tabs around a left-edge insertion slot', () => {
    const hovered: HoveredTabInsertion = {
      groupId: 'group-1',
      visibleTabId: 'tab-2',
      side: 'left'
    }

    expect(resolveTabIndicatorEdges(['tab-1', 'tab-2', 'tab-3'], hovered)).toEqual([
      { visibleTabId: 'tab-1', side: 'right' },
      { visibleTabId: 'tab-2', side: 'left' }
    ])
  })

  it('marks both tabs around a right-edge insertion slot', () => {
    const hovered: HoveredTabInsertion = {
      groupId: 'group-1',
      visibleTabId: 'tab-2',
      side: 'right'
    }

    expect(resolveTabIndicatorEdges(['tab-1', 'tab-2', 'tab-3'], hovered)).toEqual([
      { visibleTabId: 'tab-2', side: 'right' },
      { visibleTabId: 'tab-3', side: 'left' }
    ])
  })

  it('keeps a single edge marker at the strip boundaries', () => {
    expect(
      resolveTabIndicatorEdges(['tab-1', 'tab-2'], {
        groupId: 'group-1',
        visibleTabId: 'tab-1',
        side: 'left'
      })
    ).toEqual([{ visibleTabId: 'tab-1', side: 'left' }])

    expect(
      resolveTabIndicatorEdges(['tab-1', 'tab-2'], {
        groupId: 'group-1',
        visibleTabId: 'tab-2',
        side: 'right'
      })
    ).toEqual([{ visibleTabId: 'tab-2', side: 'right' }])
  })

  it('returns empty array when hoveredTabInsertion is null', () => {
    expect(resolveTabIndicatorEdges(['tab-1', 'tab-2'], null)).toEqual([])
  })

  it('returns empty array when orderedVisibleTabIds is empty', () => {
    expect(
      resolveTabIndicatorEdges([], {
        groupId: 'group-1',
        visibleTabId: 'tab-1',
        side: 'left'
      })
    ).toEqual([])
  })

  it('returns empty array when visibleTabId is not in the list', () => {
    expect(
      resolveTabIndicatorEdges(['tab-1', 'tab-2'], {
        groupId: 'group-1',
        visibleTabId: 'tab-unknown',
        side: 'left'
      })
    ).toEqual([])
  })

  it('handles a single-tab strip with left insertion', () => {
    expect(
      resolveTabIndicatorEdges(['only-tab'], {
        groupId: 'group-1',
        visibleTabId: 'only-tab',
        side: 'left'
      })
    ).toEqual([{ visibleTabId: 'only-tab', side: 'left' }])
  })

  it('handles a single-tab strip with right insertion', () => {
    expect(
      resolveTabIndicatorEdges(['only-tab'], {
        groupId: 'group-1',
        visibleTabId: 'only-tab',
        side: 'right'
      })
    ).toEqual([{ visibleTabId: 'only-tab', side: 'right' }])
  })
})
