import { describe, expect, it } from 'vitest'
import {
  getAreaSelectionAutoScrollDelta,
  getAreaSelectionCardIds,
  type AreaSelectionCardRect
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
}): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}
