import { describe, expect, it } from 'vitest'
import {
  getWorktreeSidebarDragAutoscroll,
  getWorktreeSidebarBoundaryDrop,
  getWorktreeSidebarDragRectsForGroup,
  refreshWorktreeSidebarDragSession,
  type WorktreeSidebarDragRect,
  type WorktreeSidebarDragSession
} from './worktree-sidebar-drag-autoscroll'

const CONTAINER_RECT = {
  left: 10,
  right: 210,
  top: 100,
  bottom: 500
}

const SESSION: WorktreeSidebarDragSession = {
  draggingWorktreeId: 'b',
  sourceGroupKey: 'repo:one',
  draggedIds: ['b'],
  reorderDraggedIds: ['b'],
  reorderUnitDraggedIds: ['b'],
  rects: [{ worktreeId: 'b', groupIndex: 1, top: 48, bottom: 88 }]
}

describe('getWorktreeSidebarDragAutoscroll', () => {
  it('scrolls up near the top edge', () => {
    expect(
      getWorktreeSidebarDragAutoscroll({
        point: { clientX: 80, clientY: 112 },
        containerRect: CONTAINER_RECT,
        scrollTop: 200,
        scrollHeight: 1000,
        clientHeight: 400,
        elapsedMs: 16
      })?.scrollTop
    ).toBeCloseTo(187.93, 2)
  })

  it('scrolls down near the bottom edge', () => {
    expect(
      getWorktreeSidebarDragAutoscroll({
        point: { clientX: 80, clientY: 488 },
        containerRect: CONTAINER_RECT,
        scrollTop: 200,
        scrollHeight: 1000,
        clientHeight: 400,
        elapsedMs: 16
      })?.scrollTop
    ).toBeCloseTo(212.07, 2)
  })

  it('does nothing away from the vertical edge zones', () => {
    expect(
      getWorktreeSidebarDragAutoscroll({
        point: { clientX: 80, clientY: 300 },
        containerRect: CONTAINER_RECT,
        scrollTop: 200,
        scrollHeight: 1000,
        clientHeight: 400,
        elapsedMs: 16
      })
    ).toBeNull()
  })

  it('does nothing when the pointer is outside horizontally', () => {
    expect(
      getWorktreeSidebarDragAutoscroll({
        point: { clientX: 4, clientY: 488 },
        containerRect: CONTAINER_RECT,
        scrollTop: 200,
        scrollHeight: 1000,
        clientHeight: 400,
        elapsedMs: 16
      })
    ).toBeNull()
  })

  it('does not write past scroll bounds', () => {
    expect(
      getWorktreeSidebarDragAutoscroll({
        point: { clientX: 80, clientY: 100 },
        containerRect: CONTAINER_RECT,
        scrollTop: 0,
        scrollHeight: 1000,
        clientHeight: 400,
        elapsedMs: 16
      })
    ).toBeNull()
    expect(
      getWorktreeSidebarDragAutoscroll({
        point: { clientX: 80, clientY: 500 },
        containerRect: CONTAINER_RECT,
        scrollTop: 600,
        scrollHeight: 1000,
        clientHeight: 400,
        elapsedMs: 16
      })
    ).toBeNull()
  })

  it('allows capped scrolling slightly beyond the vertical edge', () => {
    expect(
      getWorktreeSidebarDragAutoscroll({
        point: { clientX: 80, clientY: 530 },
        containerRect: CONTAINER_RECT,
        scrollTop: 200,
        scrollHeight: 1000,
        clientHeight: 400,
        elapsedMs: 16
      })?.scrollTop
    ).toBeCloseTo(215.36, 2)
    expect(
      getWorktreeSidebarDragAutoscroll({
        point: { clientX: 80, clientY: 560 },
        containerRect: CONTAINER_RECT,
        scrollTop: 200,
        scrollHeight: 1000,
        clientHeight: 400,
        elapsedMs: 16
      })
    ).toBeNull()
  })

  it('scales by elapsed frame time and clamps delayed frames', () => {
    const normal = getWorktreeSidebarDragAutoscroll({
      point: { clientX: 80, clientY: 500 },
      containerRect: CONTAINER_RECT,
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 400,
      elapsedMs: 16
    })
    const delayed = getWorktreeSidebarDragAutoscroll({
      point: { clientX: 80, clientY: 500 },
      containerRect: CONTAINER_RECT,
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 400,
      elapsedMs: 200
    })

    expect(normal?.scrollTop).toBeCloseTo(215.36, 2)
    expect(delayed?.scrollTop).toBeCloseTo(230.72, 2)
  })
})

describe('getWorktreeSidebarBoundaryDrop', () => {
  it('clamps near the group start instead of clearing the edge preview', () => {
    expect(
      getWorktreeSidebarBoundaryDrop({
        localY: 70,
        firstRect: { worktreeId: 'a', groupIndex: 0, top: 100, bottom: 140 },
        lastRect: { worktreeId: 'c', groupIndex: 2, top: 200, bottom: 240 },
        sourceGroupSize: 3
      })
    ).toEqual({ kind: 'drop', dropIndex: 0, indicatorY: 97 })
  })

  it('clamps near the group end instead of clearing the edge preview', () => {
    expect(
      getWorktreeSidebarBoundaryDrop({
        localY: 270,
        firstRect: { worktreeId: 'a', groupIndex: 0, top: 100, bottom: 140 },
        lastRect: { worktreeId: 'c', groupIndex: 2, top: 200, bottom: 240 },
        sourceGroupSize: 3
      })
    ).toEqual({ kind: 'drop', dropIndex: 3, indicatorY: 243 })
  })

  it('still rejects gaps that are not the real group edge', () => {
    expect(
      getWorktreeSidebarBoundaryDrop({
        localY: 70,
        firstRect: { worktreeId: 'b', groupIndex: 1, top: 100, bottom: 140 },
        lastRect: { worktreeId: 'c', groupIndex: 2, top: 200, bottom: 240 },
        sourceGroupSize: 4
      })
    ).toEqual({ kind: 'outside' })
    expect(
      getWorktreeSidebarBoundaryDrop({
        localY: 270,
        firstRect: { worktreeId: 'b', groupIndex: 1, top: 100, bottom: 140 },
        lastRect: { worktreeId: 'c', groupIndex: 2, top: 200, bottom: 240 },
        sourceGroupSize: 4
      })
    ).toEqual({ kind: 'outside' })
  })

  it('keeps normal in-range hover handling unchanged', () => {
    expect(
      getWorktreeSidebarBoundaryDrop({
        localY: 160,
        firstRect: { worktreeId: 'a', groupIndex: 0, top: 100, bottom: 140 },
        lastRect: { worktreeId: 'c', groupIndex: 2, top: 200, bottom: 240 },
        sourceGroupSize: 3
      })
    ).toEqual({ kind: 'inside' })
  })
})

describe('getWorktreeSidebarDragRectsForGroup', () => {
  it('refreshes mounted rects for the source group only', () => {
    const container = makeContainer([
      makeDragElement('a', 'repo:one', '0', 140, 180),
      makeDragElement('x', 'repo:two', '0', 80, 120),
      makeDragElement('b', 'repo:one', '1', 90, 130)
    ])

    expect(getWorktreeSidebarDragRectsForGroup(container, 'repo:one')).toEqual([
      { worktreeId: 'b', groupIndex: 1, top: 40, bottom: 80 },
      { worktreeId: 'a', groupIndex: 0, top: 90, bottom: 130 }
    ])
  })
})

describe('refreshWorktreeSidebarDragSession', () => {
  it('keeps the dragged set stable while refreshing rects', () => {
    const rects: WorktreeSidebarDragRect[] = [
      { worktreeId: 'a', groupIndex: 0, top: 0, bottom: 40 },
      { worktreeId: 'b', groupIndex: 1, top: 48, bottom: 88 }
    ]

    expect(
      refreshWorktreeSidebarDragSession({
        session: SESSION,
        groups: [{ key: 'repo:one', worktreeIds: ['a', 'b', 'child'] }],
        unitGroups: [
          {
            key: 'repo:one',
            worktreeIds: ['a', 'b'],
            units: [
              { worktreeId: 'a', worktreeIds: ['a'] },
              { worktreeId: 'b', worktreeIds: ['b', 'child'] }
            ]
          }
        ],
        rects
      })
    ).toEqual({ ...SESSION, rects })
  })

  it('clears when the source group is missing', () => {
    expect(
      refreshWorktreeSidebarDragSession({
        session: SESSION,
        groups: [{ key: 'repo:two', worktreeIds: ['b'] }],
        unitGroups: [{ key: 'repo:one', worktreeIds: ['b'], units: [] }],
        rects: []
      })
    ).toBeNull()
  })

  it('clears when the dragged worktree or reordered unit disappears', () => {
    expect(
      refreshWorktreeSidebarDragSession({
        session: SESSION,
        groups: [{ key: 'repo:one', worktreeIds: ['a'] }],
        unitGroups: [{ key: 'repo:one', worktreeIds: ['b'], units: [] }],
        rects: []
      })
    ).toBeNull()
    expect(
      refreshWorktreeSidebarDragSession({
        session: SESSION,
        groups: [{ key: 'repo:one', worktreeIds: ['a', 'b'] }],
        unitGroups: [{ key: 'repo:one', worktreeIds: ['a'], units: [] }],
        rects: []
      })
    ).toBeNull()
  })

  it('keeps a valid session when mounted rects are temporarily empty', () => {
    expect(
      refreshWorktreeSidebarDragSession({
        session: SESSION,
        groups: [{ key: 'repo:one', worktreeIds: ['a', 'b'] }],
        unitGroups: [{ key: 'repo:one', worktreeIds: ['a', 'b'], units: [] }],
        rects: []
      })
    ).toEqual({ ...SESSION, rects: [] })
  })
})

function makeContainer(elements: readonly ReturnType<typeof makeDragElement>[]): HTMLElement {
  return {
    scrollTop: 50,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => elements
  } as unknown as HTMLElement
}

function makeDragElement(
  worktreeId: string,
  groupKey: string,
  groupIndex: string,
  top: number,
  bottom: number
): HTMLElement {
  const attributes = new Map([
    ['data-worktree-drag-id', worktreeId],
    ['data-worktree-drag-group-key', groupKey],
    ['data-worktree-drag-group-index', groupIndex]
  ])
  return {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    getBoundingClientRect: () => ({ top, bottom })
  } as unknown as HTMLElement
}
