import { isEventTargetInsideFloatingWorkspacePanel } from '@/lib/floating-workspace-terminal-actions'

export type ViewerZoomDirection = 'in' | 'out' | 'reset'

const VIEWER_ZOOM_REQUEST_EVENT = 'orca:viewer-zoom-request'

/** Offers an app zoom command to the focused pane's PDF or image; true when a viewer took it. */
export function requestViewerZoom(direction: ViewerZoomDirection): boolean {
  const event = new CustomEvent(VIEWER_ZOOM_REQUEST_EVENT, {
    detail: direction,
    cancelable: true,
    bubbles: true
  })
  // Why: dispatch below window so popup capture precedes pane listeners.
  document.dispatchEvent(event)
  return event.defaultPrevented
}

export function listenForViewerZoomRequests(
  onZoom: (direction: ViewerZoomDirection) => void,
  rootRef: { readonly current: HTMLElement | null },
  priority: 'pane' | 'popup' = 'pane'
): () => void {
  const listener = (event: Event): void => {
    const root = rootRef.current
    if (
      !root ||
      (priority !== 'popup' &&
        isEventTargetInsideFloatingWorkspacePanel(document.activeElement) !==
          isEventTargetInsideFloatingWorkspacePanel(root))
    ) {
      return
    }
    const direction: unknown = event instanceof CustomEvent ? event.detail : null
    if (direction === 'in' || direction === 'out' || direction === 'reset') {
      event.preventDefault()
      if (priority === 'popup') {
        event.stopImmediatePropagation()
      }
      onZoom(direction)
    }
  }
  const capture = priority === 'popup'
  window.addEventListener(VIEWER_ZOOM_REQUEST_EVENT, listener, capture)
  return () => window.removeEventListener(VIEWER_ZOOM_REQUEST_EVENT, listener, capture)
}
