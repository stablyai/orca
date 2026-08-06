import { describe, expect, it } from 'vitest'
import { getAreaSelectionCardRects } from './workspace-kanban-area-selection-card-rects'
import { getAreaSelectionCardIds } from './workspace-kanban-area-selection-dom'
import {
  getWorkspaceKanbanVirtualLaneItemRects,
  registerWorkspaceKanbanVirtualLaneLayout,
  resolveWorkspaceKanbanVirtualLaneDropIndex,
  resolveWorkspaceKanbanVirtualLaneDropIndicatorY
} from './workspace-kanban-virtual-lane-layout'

const ITEM_COUNT = 102
const ITEM_STRIDE = 44
const ITEM_HEIGHT = 36

function createLayoutElements(): {
  scrollElement: HTMLElement
  spacerElement: HTMLElement
} {
  const scrollElement = {
    scrollTop: 0,
    getBoundingClientRect: () => ({
      left: 20,
      top: 100,
      right: 220,
      bottom: 600,
      width: 200,
      height: 500
    })
  } as unknown as HTMLElement
  const spacerElement = {
    getBoundingClientRect: () => ({
      left: 26,
      top: 108 - scrollElement.scrollTop,
      right: 214,
      bottom: 108 - scrollElement.scrollTop + ITEM_COUNT * ITEM_STRIDE,
      width: 188,
      height: ITEM_COUNT * ITEM_STRIDE
    })
  } as unknown as HTMLElement
  return { scrollElement, spacerElement }
}

function registerLayout(scrollElement: HTMLElement, spacerElement: HTMLElement): () => void {
  return registerWorkspaceKanbanVirtualLaneLayout({
    scrollElement,
    spacerElement,
    getItemIds: () => Array.from({ length: ITEM_COUNT }, (_, index) => `w${index}`),
    getMeasurements: () =>
      Array.from({ length: ITEM_COUNT }, (_, index) => ({
        index,
        start: index * ITEM_STRIDE,
        end: index * ITEM_STRIDE + ITEM_HEIGHT
      }))
  })
}

describe('workspace kanban virtual lane layout', () => {
  it('resolves mid-lane and bottom drops immediately after a large scroll jump', () => {
    const { scrollElement, spacerElement } = createLayoutElements()
    const unregister = registerLayout(scrollElement, spacerElement)
    scrollElement.scrollTop = 3_980

    expect(resolveWorkspaceKanbanVirtualLaneDropIndex(scrollElement, 370)).toBe(97)
    expect(resolveWorkspaceKanbanVirtualLaneDropIndex(scrollElement, 590)).toBe(102)
    expect(resolveWorkspaceKanbanVirtualLaneDropIndicatorY(scrollElement, 102)).toBe(613)
    unregister()
  })

  it('exposes every logical item even when no card is mounted', () => {
    const { scrollElement, spacerElement } = createLayoutElements()
    const unregister = registerLayout(scrollElement, spacerElement)
    scrollElement.scrollTop = 3_980

    const rects = getWorkspaceKanbanVirtualLaneItemRects(scrollElement)
    expect(rects).toHaveLength(ITEM_COUNT)
    expect(rects?.[50]).toMatchObject({
      id: 'w50',
      index: 50,
      contentTop: 2_208,
      contentBottom: 2_244
    })
    unregister()
  })

  it('selects intermediate never-mounted cards across a jumped lane range', () => {
    const { scrollElement, spacerElement } = createLayoutElements()
    const unregister = registerLayout(scrollElement, spacerElement)
    scrollElement.scrollTop = 3_980
    const board = {
      querySelectorAll: (selector: string) =>
        selector === '[data-workspace-board-lane-scroll]' ? [scrollElement] : []
    } as unknown as HTMLElement

    const cardRects = getAreaSelectionCardRects(board)
    const selectedIds = getAreaSelectionCardIds(
      cardRects,
      { left: 0, top: 110, width: 300, height: 480 },
      {
        scrollStartContentYByElement: new Map([[scrollElement, 18]]),
        currentY: 590
      }
    )

    expect(cardRects.every((card) => card.element === null)).toBe(true)
    expect(selectedIds).toHaveLength(ITEM_COUNT)
    expect(selectedIds).toContain('w50')
    unregister()
  })

  it('does not let stale cleanup remove a newer lane registration', () => {
    const { scrollElement, spacerElement } = createLayoutElements()
    const unregisterFirst = registerWorkspaceKanbanVirtualLaneLayout({
      scrollElement,
      spacerElement,
      getItemIds: () => ['old'],
      getMeasurements: () => [{ index: 0, start: 0, end: ITEM_HEIGHT }]
    })
    const unregisterSecond = registerWorkspaceKanbanVirtualLaneLayout({
      scrollElement,
      spacerElement,
      getItemIds: () => ['new'],
      getMeasurements: () => [{ index: 0, start: 0, end: ITEM_HEIGHT }]
    })

    unregisterFirst()
    expect(getWorkspaceKanbanVirtualLaneItemRects(scrollElement)?.map((item) => item.id)).toEqual([
      'new'
    ])
    unregisterSecond()
    expect(getWorkspaceKanbanVirtualLaneItemRects(scrollElement)).toBeNull()
  })

  it('places empty-lane and boundary drop indicators from the spacer', () => {
    const { scrollElement, spacerElement } = createLayoutElements()
    const unregisterEmpty = registerWorkspaceKanbanVirtualLaneLayout({
      scrollElement,
      spacerElement,
      getItemIds: () => [],
      getMeasurements: () => []
    })
    expect(resolveWorkspaceKanbanVirtualLaneDropIndex(scrollElement, 200)).toBe(0)
    expect(resolveWorkspaceKanbanVirtualLaneDropIndicatorY(scrollElement, 0)).toBe(114)
    unregisterEmpty()

    const unregister = registerLayout(scrollElement, spacerElement)
    expect(resolveWorkspaceKanbanVirtualLaneDropIndex(scrollElement, 90)).toBe(0)
    expect(resolveWorkspaceKanbanVirtualLaneDropIndicatorY(scrollElement, 0)).toBe(103)
    expect(resolveWorkspaceKanbanVirtualLaneDropIndicatorY(scrollElement, 1)).toBe(148)
    unregister()
  })

  it('returns null when measurements are incomplete or mismatched', () => {
    const { scrollElement, spacerElement } = createLayoutElements()
    const unregisterShort = registerWorkspaceKanbanVirtualLaneLayout({
      scrollElement,
      spacerElement,
      getItemIds: () => ['a', 'b'],
      getMeasurements: () => [{ index: 0, start: 0, end: ITEM_HEIGHT }]
    })
    expect(getWorkspaceKanbanVirtualLaneItemRects(scrollElement)).toBeNull()
    expect(resolveWorkspaceKanbanVirtualLaneDropIndex(scrollElement, 120)).toBeNull()
    unregisterShort()

    const unregisterBadIndex = registerWorkspaceKanbanVirtualLaneLayout({
      scrollElement,
      spacerElement,
      getItemIds: () => ['a'],
      getMeasurements: () => [{ index: 3, start: 0, end: ITEM_HEIGHT }]
    })
    expect(getWorkspaceKanbanVirtualLaneItemRects(scrollElement)).toBeNull()
    unregisterBadIndex()
  })
})
