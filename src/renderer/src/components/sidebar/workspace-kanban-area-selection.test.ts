// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { AreaSelectionCardRect } from './workspace-kanban-area-selection-card-rects'
import {
  getAreaSelectionAutoScrollDelta,
  getAreaSelectionCardIds,
  updatePreviewSelection
} from './workspace-kanban-area-selection-dom'
import { shouldCommitWorkspaceKanbanAreaSelection } from './use-workspace-kanban-area-selection'

describe('workspace kanban area selection finish', () => {
  it('commits an empty non-additive surface click so selection clears', () => {
    expect(
      shouldCommitWorkspaceKanbanAreaSelection({
        additive: false,
        started: false
      })
    ).toBe(true)
  })

  it('ignores empty additive surface clicks so modifier-click off does not clear', () => {
    expect(
      shouldCommitWorkspaceKanbanAreaSelection({
        additive: true,
        started: false
      })
    ).toBe(false)
  })

  it('commits marquee drags even when additive', () => {
    expect(
      shouldCommitWorkspaceKanbanAreaSelection({
        additive: true,
        started: true
      })
    ).toBe(true)
  })
})

describe('workspace kanban area selection auto-scroll', () => {
  it('scrolls down near the bottom edge while more lane content is available', () => {
    expect(
      getAreaSelectionAutoScrollDelta({
        pointerY: 585,
        containerTop: 100,
        containerBottom: 600,
        scrollTop: 40,
        scrollHeight: 1200,
        clientHeight: 500
      })
    ).toBeGreaterThan(0)
  })

  it('scrolls up near the top edge while content exists above', () => {
    expect(
      getAreaSelectionAutoScrollDelta({
        pointerY: 112,
        containerTop: 100,
        containerBottom: 600,
        scrollTop: 40,
        scrollHeight: 1200,
        clientHeight: 500
      })
    ).toBeLessThan(0)
  })

  it('does not scroll when the pointer is away from the edges or at scroll limits', () => {
    expect(
      getAreaSelectionAutoScrollDelta({
        pointerY: 350,
        containerTop: 100,
        containerBottom: 600,
        scrollTop: 40,
        scrollHeight: 1200,
        clientHeight: 500
      })
    ).toBe(0)
    expect(
      getAreaSelectionAutoScrollDelta({
        pointerY: 585,
        containerTop: 100,
        containerBottom: 600,
        scrollTop: 700,
        scrollHeight: 1200,
        clientHeight: 500
      })
    ).toBe(0)
  })
})

describe('workspace kanban area selection scrolled content hit-testing', () => {
  it('keeps cards selected after lane scroll moves them above the viewport marquee', () => {
    const scrollContainer = {} as HTMLElement
    const cards: AreaSelectionCardRect[] = [
      {
        id: 'top-card',
        element: {} as HTMLElement,
        rect: makeRect({ left: 20, top: 20, right: 220, bottom: 70 }),
        scrollContainer,
        contentRect: {
          top: 120,
          bottom: 170,
          containerTop: 100,
          scrollTop: 200
        }
      },
      {
        id: 'below-current-pointer',
        element: {} as HTMLElement,
        rect: makeRect({ left: 20, top: 600, right: 220, bottom: 650 }),
        scrollContainer,
        contentRect: {
          top: 700,
          bottom: 750,
          containerTop: 100,
          scrollTop: 200
        }
      }
    ]

    expect(
      getAreaSelectionCardIds(
        cards,
        {
          left: 0,
          top: 230,
          width: 260,
          height: 350
        },
        {
          scrollStartContentYByElement: new Map([[scrollContainer, 130]]),
          currentY: 580
        }
      )
    ).toEqual(['top-card'])
  })

  it('falls back to viewport hit-testing for cards outside lane scrollers', () => {
    expect(
      getAreaSelectionCardIds(
        [
          {
            id: 'visible-card',
            element: {} as HTMLElement,
            rect: makeRect({ left: 20, top: 250, right: 220, bottom: 300 }),
            scrollContainer: null,
            contentRect: null
          }
        ],
        {
          left: 0,
          top: 230,
          width: 260,
          height: 350
        }
      )
    ).toEqual(['visible-card'])
  })
})

function makeRect({
  left,
  top,
  right,
  bottom
}: {
  left: number
  top: number
  right: number
  bottom: number
}): AreaSelectionCardRect['rect'] {
  return { left, top, right, bottom }
}

describe('workspace kanban area selection preview remount', () => {
  it('re-applies the preview attribute when a card remounts under the same id', () => {
    const first = document.createElement('div')
    first.setAttribute('data-workspace-board-card-id', 'card-a')
    Object.defineProperty(first, 'isConnected', { value: true })
    const previewIds = new Set<string>()
    updatePreviewSelection(
      [
        {
          id: 'card-a',
          element: first,
          rect: makeRect({ left: 0, top: 0, right: 100, bottom: 40 }),
          scrollContainer: null,
          contentRect: null
        }
      ],
      previewIds,
      new Set(),
      false,
      ['card-a']
    )
    expect(first.getAttribute('data-workspace-board-card-area-selected')).toBe('true')
    expect(previewIds.has('card-a')).toBe(true)

    const remounted = document.createElement('div')
    remounted.setAttribute('data-workspace-board-card-id', 'card-a')
    Object.defineProperty(remounted, 'isConnected', { value: true })
    updatePreviewSelection(
      [
        {
          id: 'card-a',
          element: remounted,
          rect: makeRect({ left: 0, top: 0, right: 100, bottom: 40 }),
          scrollContainer: null,
          contentRect: null
        }
      ],
      previewIds,
      new Set(),
      false,
      ['card-a']
    )
    expect(remounted.getAttribute('data-workspace-board-card-area-selected')).toBe('true')
  })
})
