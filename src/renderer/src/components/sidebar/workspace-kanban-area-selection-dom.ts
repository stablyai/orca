export type AreaSelectionRect = {
  left: number
  top: number
  width: number
  height: number
}

export type AreaSelectionCardRect = {
  id: string
  element: HTMLElement
  rect: DOMRect
  scrollContainer: HTMLElement | null
  contentRect: AreaSelectionCardContentRect | null
}

type AreaSelectionCardContentRect = {
  top: number
  bottom: number
  containerTop: number
  scrollTop: number
}

type AreaSelectionAutoScrollParams = {
  pointerY: number
  containerTop: number
  containerBottom: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  edgeSize?: number
  maxDelta?: number
}

type AreaSelectionCardIdOptions = {
  scrollStartContentYByElement?: ReadonlyMap<HTMLElement, number>
  currentY?: number
}

const AREA_SELECTED_ATTR = 'data-workspace-board-card-area-selected'
export const AREA_SELECTION_SCROLL_CONTAINER_SELECTOR = '[data-workspace-board-lane-scroll]'
export const AREA_SELECTION_AUTO_SCROLL_EDGE_SIZE = 48
export const AREA_SELECTION_AUTO_SCROLL_MAX_DELTA = 22

export function getAreaSelectionRect(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number
): AreaSelectionRect {
  const left = Math.min(startX, currentX)
  const top = Math.min(startY, currentY)
  return {
    left,
    top,
    width: Math.abs(currentX - startX),
    height: Math.abs(currentY - startY)
  }
}

export function shouldIgnoreAreaSelectionStart(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false
  }
  return Boolean(
    target.closest(
      [
        '[data-workspace-board-card-id]',
        'a',
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[role="menu"]',
        '[role="menuitem"]'
      ].join(',')
    )
  )
}

export function isScrollbarPointerDown(
  event: Pick<PointerEvent, 'target' | 'clientX' | 'clientY'>
): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const rect = target.getBoundingClientRect()
  const hitsVerticalScrollbar =
    target.scrollHeight > target.clientHeight && event.clientX >= rect.right - 14
  const hitsHorizontalScrollbar =
    target.scrollWidth > target.clientWidth && event.clientY >= rect.bottom - 14
  return hitsVerticalScrollbar || hitsHorizontalScrollbar
}

export function getAreaSelectionCardRects(board: HTMLElement): AreaSelectionCardRect[] {
  const cardRects: AreaSelectionCardRect[] = []
  const seen = new Set<string>()
  const scrollMetrics = new Map<HTMLElement, { containerTop: number; scrollTop: number }>()
  const cards = board.querySelectorAll<HTMLElement>('[data-workspace-board-card-id]')
  for (const card of cards) {
    const id = card.dataset.workspaceBoardCardId
    if (!id || seen.has(id)) {
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
    cardRects.push({
      id,
      element: card,
      rect,
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
    seen.add(id)
  }
  return cardRects
}

export function getAreaSelectionCardIds(
  cardRects: readonly AreaSelectionCardRect[],
  selectionRect: AreaSelectionRect,
  options: AreaSelectionCardIdOptions = {}
): string[] {
  const ids: string[] = []
  for (const card of cardRects) {
    const horizontalHit =
      selectionRect.left <= card.rect.right &&
      selectionRect.left + selectionRect.width >= card.rect.left
    if (!horizontalHit) {
      continue
    }
    const startContentY = card.scrollContainer
      ? options.scrollStartContentYByElement?.get(card.scrollContainer)
      : undefined
    let verticalHit =
      selectionRect.top <= card.rect.bottom &&
      selectionRect.top + selectionRect.height >= card.rect.top
    if (startContentY !== undefined && card.contentRect && options.currentY !== undefined) {
      const currentContentY =
        options.currentY - card.contentRect.containerTop + card.contentRect.scrollTop
      // Why: during lane scroll, viewport Y changes but the marquee range is
      // anchored to the content positions the user dragged across.
      verticalHit =
        Math.min(startContentY, currentContentY) <= card.contentRect.bottom &&
        Math.max(startContentY, currentContentY) >= card.contentRect.top
    }
    if (verticalHit) {
      ids.push(card.id)
    }
  }
  return ids
}

export function getAreaSelectionScrollStartContentYByElement(
  board: HTMLElement,
  pointerY: number
): Map<HTMLElement, number> {
  const startContentYByElement = new Map<HTMLElement, number>()
  const containers = board.querySelectorAll<HTMLElement>(AREA_SELECTION_SCROLL_CONTAINER_SELECTOR)
  for (const element of containers) {
    const rect = element.getBoundingClientRect()
    startContentYByElement.set(element, pointerY - rect.top + element.scrollTop)
  }
  return startContentYByElement
}

export function getAreaSelectionAutoScrollDelta({
  pointerY,
  containerTop,
  containerBottom,
  scrollTop,
  scrollHeight,
  clientHeight,
  edgeSize = AREA_SELECTION_AUTO_SCROLL_EDGE_SIZE,
  maxDelta = AREA_SELECTION_AUTO_SCROLL_MAX_DELTA
}: AreaSelectionAutoScrollParams): number {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight)
  if (maxScrollTop <= 0) {
    return 0
  }

  const topDistance = containerTop + edgeSize - pointerY
  if (topDistance > 0 && scrollTop > 0) {
    const ratio = Math.min(1, topDistance / edgeSize)
    return -Math.min(scrollTop, Math.max(1, Math.ceil(ratio * maxDelta)))
  }

  const bottomDistance = pointerY - (containerBottom - edgeSize)
  if (bottomDistance > 0 && scrollTop < maxScrollTop) {
    const ratio = Math.min(1, bottomDistance / edgeSize)
    return Math.min(maxScrollTop - scrollTop, Math.max(1, Math.ceil(ratio * maxDelta)))
  }

  return 0
}

export function getAreaSelectionScrollContainer(
  board: HTMLElement,
  pointerX: number,
  pointerY: number
): HTMLElement | null {
  const containers = board.querySelectorAll<HTMLElement>(AREA_SELECTION_SCROLL_CONTAINER_SELECTOR)
  let nearest: { element: HTMLElement; distance: number } | null = null

  for (const element of containers) {
    const rect = element.getBoundingClientRect()
    if (pointerX < rect.left || pointerX > rect.right) {
      continue
    }
    const distance =
      pointerY < rect.top
        ? rect.top - pointerY
        : pointerY > rect.bottom
          ? pointerY - rect.bottom
          : 0
    if (distance > AREA_SELECTION_AUTO_SCROLL_EDGE_SIZE * 2) {
      continue
    }
    if (!nearest || distance < nearest.distance) {
      nearest = { element, distance }
    }
  }

  return nearest?.element ?? null
}

export function setOverlayRect(overlay: HTMLElement | null, rect: AreaSelectionRect | null): void {
  if (!overlay || !rect) {
    overlay?.classList.add('hidden')
    return
  }
  overlay.classList.remove('hidden')
  overlay.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`
  overlay.style.width = `${rect.width}px`
  overlay.style.height = `${rect.height}px`
}

export function clearPreviewSelection(
  cardRects: readonly AreaSelectionCardRect[],
  previewIds: Set<string>
): void {
  for (const card of cardRects) {
    if (previewIds.has(card.id)) {
      card.element.removeAttribute(AREA_SELECTED_ATTR)
    }
  }
  previewIds.clear()
}

export function updatePreviewSelection(
  cardRects: readonly AreaSelectionCardRect[],
  previewIds: Set<string>,
  baseSelectedIds: ReadonlySet<string>,
  additive: boolean,
  areaIds: readonly string[]
): void {
  const nextIds = additive ? new Set(baseSelectedIds) : new Set<string>()
  for (const id of areaIds) {
    nextIds.add(id)
  }

  for (const card of cardRects) {
    const shouldPreview = nextIds.has(card.id)
    const isPreviewed = previewIds.has(card.id)
    if (shouldPreview === isPreviewed) {
      continue
    }
    if (shouldPreview) {
      card.element.setAttribute(AREA_SELECTED_ATTR, 'true')
      previewIds.add(card.id)
    } else {
      card.element.removeAttribute(AREA_SELECTED_ATTR)
      previewIds.delete(card.id)
    }
  }
}
