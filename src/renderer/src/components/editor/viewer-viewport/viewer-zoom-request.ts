import { isEventTargetInsideFloatingWorkspacePanel } from '@/components/floating-terminal/floating-workspace-terminal-actions'

export type ViewerZoomDirection = 'in' | 'out' | 'reset'

const VIEWER_ZOOM_REQUEST_EVENT = 'orca:viewer-zoom-request'
const OPEN_DIALOG_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'

function dispatchViewerZoomRequest(
  direction: ViewerZoomDirection,
  scope: Document | Element
): boolean {
  const event = new CustomEvent(VIEWER_ZOOM_REQUEST_EVENT, {
    detail: direction,
    cancelable: true,
    bubbles: true
  })
  // Why: dispatch below window so popup capture precedes pane listeners.
  scope.dispatchEvent(event)
  return event.defaultPrevented
}

/** Offers an app zoom command to the focused pane's PDF or image; true when a viewer took it. */
export function requestViewerZoom(direction: ViewerZoomDirection): boolean {
  return dispatchViewerZoomRequest(direction, document)
}

/** Offers an app zoom command to a viewer in the frontmost open dialog; true when one took it. */
export function requestFrontDialogViewerZoom(direction: ViewerZoomDirection): boolean {
  // Why: dialogs portal to the end of the body as they open, so the last open one is drawn on top.
  const frontDialog = [...document.querySelectorAll(OPEN_DIALOG_SELECTOR)].at(-1)
  return frontDialog ? dispatchViewerZoomRequest(direction, frontDialog) : false
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
      // Why: a request sent into a dialog belongs only to viewers inside it.
      !(event.target instanceof Node && event.target.contains(root)) ||
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
