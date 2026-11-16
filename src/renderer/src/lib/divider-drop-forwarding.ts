const DIVIDER_SELECTOR = '.tab-group-split-resize-handle, .pane-divider'
const forwardedDragEvents = new WeakSet<DragEvent>()

/** True for a drag event a divider re-sent from a trusted one, so drop owners can accept it. */
export function isForwardedTrustedDragEvent(event: DragEvent): boolean {
  return forwardedDragEvents.has(event)
}

/**
 * A split gap has no drop owner of its own. Hand drags over it to the pane on the nearer side of
 * the line (the first/left/upper pane on the center pixel), so the gap is never a dead drop zone.
 */
export function attachDividerDropForwarding(
  divider: HTMLElement,
  isVerticalLine: () => boolean
): () => void {
  let forwardTarget: Element | null = null

  const probe = (event: DragEvent): { target: Element; x: number; y: number } | null => {
    const rect = divider.getBoundingClientRect()
    const vertical = isVerticalLine()
    const firstSide = vertical
      ? event.clientX <= rect.left + rect.width / 2
      : event.clientY <= rect.top + rect.height / 2
    const x = vertical ? (firstSide ? rect.left - 1 : rect.right + 1) : event.clientX
    const y = vertical ? event.clientY : firstSide ? rect.top - 1 : rect.bottom + 1
    const target = document.elementsFromPoint(x, y).find((el) => !el.closest(DIVIDER_SELECTOR))
    return target ? { target, x, y } : null
  }

  const forward = (type: string, target: Element, source: DragEvent, x: number, y: number) => {
    const forwarded = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: source.screenX + (x - source.clientX),
      screenY: source.screenY + (y - source.clientY),
      altKey: source.altKey,
      ctrlKey: source.ctrlKey,
      metaKey: source.metaKey,
      shiftKey: source.shiftKey,
      dataTransfer: source.dataTransfer
    })
    forwardedDragEvents.add(forwarded)
    target.dispatchEvent(forwarded)
  }

  const leaveCurrent = (source: DragEvent): void => {
    if (forwardTarget?.isConnected) {
      forward('dragleave', forwardTarget, source, source.clientX, source.clientY)
    }
    forwardTarget = null
  }

  const onDragEnterOrOver = (event: DragEvent): void => {
    if (!event.isTrusted) {
      return
    }
    const hit = probe(event)
    if (hit && hit.target !== forwardTarget) {
      leaveCurrent(event)
      forward('dragenter', hit.target, event, hit.x, hit.y)
      forwardTarget = hit.target
    }
    if (!hit) {
      return
    }
    if (event.type === 'dragover') {
      forward('dragover', hit.target, event, hit.x, hit.y)
    }
    // Why: the pane's handler already set dropEffect on the shared DataTransfer; the gap only relays it.
    event.preventDefault()
    event.stopPropagation()
  }

  const onDragLeave = (event: DragEvent): void => {
    const related = event.relatedTarget
    if (!event.isTrusted || (related instanceof Node && divider.contains(related))) {
      return
    }
    leaveCurrent(event)
    event.stopPropagation()
  }

  const onDrop = (event: DragEvent): void => {
    if (!event.isTrusted) {
      return
    }
    const hit = probe(event)
    forwardTarget = null
    if (!hit) {
      return
    }
    forward('drop', hit.target, event, hit.x, hit.y)
    event.preventDefault()
    event.stopPropagation()
  }

  divider.addEventListener('dragenter', onDragEnterOrOver)
  divider.addEventListener('dragover', onDragEnterOrOver)
  divider.addEventListener('dragleave', onDragLeave)
  divider.addEventListener('drop', onDrop)
  return () => {
    divider.removeEventListener('dragenter', onDragEnterOrOver)
    divider.removeEventListener('dragover', onDragEnterOrOver)
    divider.removeEventListener('dragleave', onDragLeave)
    divider.removeEventListener('drop', onDrop)
    forwardTarget = null
  }
}
