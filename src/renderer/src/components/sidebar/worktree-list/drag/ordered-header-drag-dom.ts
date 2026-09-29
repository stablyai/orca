/** One header's vertical extent inside the scroll container, in container coordinates. */
export type OrderedHeaderRect = {
  id: string
  top: number
  bottom: number
}

const HEADER_ACTION_SELECTOR =
  '[data-host-header-action], button, a, input, textarea, select, [contenteditable=""], [contenteditable="true"]'

export function isSidebarHeaderActionTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  // Why: an <svg> icon inside an action is an SVGElement, so match Element to
  // still treat it as an action target and not arm a header drag.
  if (!(target instanceof Element) || target === currentTarget) {
    return false
  }
  return currentTarget.contains(target) && target.closest(HEADER_ACTION_SELECTOR) !== null
}

/** Read a tier's header rects in DOM order; `readId` rejects headers that cannot be dragged. */
export function readOrderedHeaderRects(
  container: HTMLElement,
  selector: string,
  readId: (header: HTMLElement) => string | null
): OrderedHeaderRect[] {
  const containerRect = container.getBoundingClientRect()
  const headerRects: OrderedHeaderRect[] = []
  for (const header of Array.from(container.querySelectorAll<HTMLElement>(selector))) {
    const id = readId(header)
    if (!id) {
      continue
    }
    const rect = header.getBoundingClientRect()
    headerRects.push({
      id,
      top: rect.top - containerRect.top + container.scrollTop,
      bottom: rect.bottom - containerRect.top + container.scrollTop
    })
  }
  return headerRects
}
