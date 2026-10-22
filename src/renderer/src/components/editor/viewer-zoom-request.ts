export type ViewerZoomDirection = 'in' | 'out' | 'reset'

const VIEWER_ZOOM_REQUEST_EVENT = 'orca:viewer-zoom-request'

/** Offers an app zoom command to the focused pane's PDF or image; true when a viewer took it. */
export function requestViewerZoom(direction: ViewerZoomDirection): boolean {
  const event = new CustomEvent(VIEWER_ZOOM_REQUEST_EVENT, { detail: direction, cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

export function listenForViewerZoomRequests(
  onZoom: (direction: ViewerZoomDirection) => void
): () => void {
  const listener = (event: Event): void => {
    const direction: unknown = event instanceof CustomEvent ? event.detail : null
    if (direction === 'in' || direction === 'out' || direction === 'reset') {
      event.preventDefault()
      onZoom(direction)
    }
  }
  window.addEventListener(VIEWER_ZOOM_REQUEST_EVENT, listener)
  return () => window.removeEventListener(VIEWER_ZOOM_REQUEST_EVENT, listener)
}
