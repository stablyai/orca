import { getWorkspaceKanbanVirtualLaneItemRects } from './workspace-kanban-virtual-lane-layout'

type AreaSelectionCardContentRect = {
  top: number
  bottom: number
  containerTop: number
  scrollTop: number
}

export type AreaSelectionViewportRect = {
  left: number
  top: number
  right: number
  bottom: number
}

export type AreaSelectionCardRect = {
  id: string
  element: HTMLElement | null
  rect: AreaSelectionViewportRect
  scrollContainer: HTMLElement | null
  contentRect: AreaSelectionCardContentRect | null
}

export const AREA_SELECTION_SCROLL_CONTAINER_SELECTOR = '[data-workspace-board-lane-scroll]'

export function getAreaSelectionCardRects(board: HTMLElement): AreaSelectionCardRect[] {
  const cardRects = new Map<string, AreaSelectionCardRect>()
  const scrollMetrics = new Map<HTMLElement, { containerTop: number; scrollTop: number }>()
  const scrollContainers = board.querySelectorAll<HTMLElement>(
    AREA_SELECTION_SCROLL_CONTAINER_SELECTOR
  )
  for (const scrollContainer of scrollContainers) {
    const virtualRects = getWorkspaceKanbanVirtualLaneItemRects(scrollContainer)
    if (!virtualRects) {
      continue
    }
    const containerTop = scrollContainer.getBoundingClientRect().top
    const scrollTop = scrollContainer.scrollTop
    scrollMetrics.set(scrollContainer, { containerTop, scrollTop })
    for (const virtualRect of virtualRects) {
      cardRects.set(virtualRect.id, {
        id: virtualRect.id,
        element: null,
        rect: {
          left: virtualRect.left,
          top: virtualRect.top,
          right: virtualRect.right,
          bottom: virtualRect.bottom
        },
        scrollContainer,
        contentRect: {
          top: virtualRect.contentTop,
          bottom: virtualRect.contentBottom,
          containerTop,
          scrollTop
        }
      })
    }
  }

  const cards = board.querySelectorAll<HTMLElement>('[data-workspace-board-card-id]')
  for (const card of cards) {
    const id = card.dataset.workspaceBoardCardId
    if (!id) {
      continue
    }
    const rect = card.getBoundingClientRect()
    const scrollContainer = card.closest<HTMLElement>(AREA_SELECTION_SCROLL_CONTAINER_SELECTOR)
    let metrics = scrollContainer ? scrollMetrics.get(scrollContainer) : undefined
    if (scrollContainer && !metrics) {
      metrics = {
        containerTop: scrollContainer.getBoundingClientRect().top,
        scrollTop: scrollContainer.scrollTop
      }
      scrollMetrics.set(scrollContainer, metrics)
    }
    cardRects.set(id, {
      id,
      element: card,
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      },
      scrollContainer,
      contentRect: metrics
        ? {
            top: rect.top - metrics.containerTop + metrics.scrollTop,
            bottom: rect.bottom - metrics.containerTop + metrics.scrollTop,
            containerTop: metrics.containerTop,
            scrollTop: metrics.scrollTop
          }
        : null
    })
  }
  return Array.from(cardRects.values())
}
