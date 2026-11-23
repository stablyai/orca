export type VerticalScrollbarGutterBox = {
  offsetWidth: number
  clientWidth: number
  left: number
  right: number
  direction: 'ltr' | 'rtl'
}

export type BorderBox = {
  left: number
  top: number
  right: number
  bottom: number
}

type DismissPointerEvent = {
  clientX?: unknown
  clientY?: unknown
  detail?: { originalEvent?: { clientX?: unknown; clientY?: unknown } }
}

/** The vertical scrollbar sits in `offsetWidth - clientWidth` at the right edge, or the left edge in RTL. */
export function isClientXInVerticalScrollbarGutter(
  box: VerticalScrollbarGutterBox,
  clientX: number
): boolean {
  const gutter = box.offsetWidth - box.clientWidth
  if (gutter <= 0) {
    return false
  }
  if (box.direction === 'rtl') {
    return clientX >= box.left && clientX <= box.left + gutter
  }
  return clientX >= box.right - gutter && clientX <= box.right
}

export function isClientPointInsideBorderBox(
  box: BorderBox,
  clientX: number,
  clientY: number
): boolean {
  return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom
}

function finiteClientPoint(
  source: { clientX?: unknown; clientY?: unknown } | undefined
): { x: number; y: number } | null {
  if (typeof source?.clientX !== 'number' || typeof source.clientY !== 'number') {
    return null
  }
  return { x: source.clientX, y: source.clientY }
}

/** Radix pointerdown-outside carries the point on `detail.originalEvent`. */
export function clientPointOfDismissEvent(
  event: DismissPointerEvent
): { x: number; y: number } | null {
  return finiteClientPoint(event.detail?.originalEvent) ?? finiteClientPoint(event)
}

export function dismissPointerIsInsideBorderBox(
  event: DismissPointerEvent,
  box: BorderBox
): boolean {
  const point = clientPointOfDismissEvent(event)
  return point !== null && isClientPointInsideBorderBox(box, point.x, point.y)
}

export function pointerIsInVerticalScrollbarGutter(element: HTMLElement, clientX: number): boolean {
  const rect = element.getBoundingClientRect()
  return isClientXInVerticalScrollbarGutter(
    {
      offsetWidth: element.offsetWidth,
      clientWidth: element.clientWidth,
      left: rect.left,
      right: rect.right,
      direction: getComputedStyle(element).direction === 'rtl' ? 'rtl' : 'ltr'
    },
    clientX
  )
}
