export type PdfZoomDirection = 'in' | 'out' | 'reset'

const PDF_ZOOM_REQUEST_EVENT = 'orca:pdf-zoom-request'

/** Offers an app zoom command to the focused pane's PDF; true when a PDF took it. */
export function requestPdfZoom(direction: PdfZoomDirection): boolean {
  const event = new CustomEvent(PDF_ZOOM_REQUEST_EVENT, { detail: direction, cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

export function listenForPdfZoomRequests(
  onZoom: (direction: PdfZoomDirection) => void
): () => void {
  const listener = (event: Event): void => {
    const direction: unknown = event instanceof CustomEvent ? event.detail : null
    if (direction === 'in' || direction === 'out' || direction === 'reset') {
      event.preventDefault()
      onZoom(direction)
    }
  }
  window.addEventListener(PDF_ZOOM_REQUEST_EVENT, listener)
  return () => window.removeEventListener(PDF_ZOOM_REQUEST_EVENT, listener)
}
