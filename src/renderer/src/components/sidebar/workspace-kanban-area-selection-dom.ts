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
}

const AREA_SELECTED_ATTR = 'data-workspace-board-card-area-selected'

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
        '[data-workspace-pin-drop-target]',
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
  const cards = board.querySelectorAll<HTMLElement>('[data-workspace-board-card-id]')
  for (const card of cards) {
    const id = card.dataset.workspaceBoardCardId
    if (!id || seen.has(id)) {
      continue
    }
    cardRects.push({ id, element: card, rect: card.getBoundingClientRect() })
    seen.add(id)
  }
  return cardRects
}

export function getAreaSelectionCardIds(
  cardRects: readonly AreaSelectionCardRect[],
  selectionRect: AreaSelectionRect
): string[] {
  const ids: string[] = []
  for (const card of cardRects) {
    if (
      selectionRect.left <= card.rect.right &&
      selectionRect.left + selectionRect.width >= card.rect.left &&
      selectionRect.top <= card.rect.bottom &&
      selectionRect.top + selectionRect.height >= card.rect.top
    ) {
      ids.push(card.id)
    }
  }
  return ids
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
