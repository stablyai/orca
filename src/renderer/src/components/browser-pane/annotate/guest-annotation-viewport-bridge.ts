import type {
  BrowserGrabPayload,
  BrowserPageAnnotation
} from '../../../../../shared/browser-grab-types'

// Guest-rendered badges track scrolling without a renderer message per frame.
export function syncGuestAnnotationViewportBridge({
  toolTargetId,
  annotations,
  currentUrl,
  pendingPayload,
  surfaceActive,
  token
}: {
  toolTargetId: string
  annotations: BrowserPageAnnotation[]
  currentUrl?: string
  pendingPayload: BrowserGrabPayload | null
  surfaceActive: boolean
  token: string
}): void {
  // Why: existing badges render in-guest for smooth scroll; only the pending dialog needs viewport messages.
  // Keep the full-list index so badges still match the tray after filtering other pages.
  const markers = annotations.flatMap((annotation, index) =>
    currentUrl !== undefined && annotation.payload.page.sanitizedUrl !== currentUrl
      ? []
      : [
          {
            id: annotation.id,
            index,
            isFixed: annotation.payload.target.isFixed === true,
            rectPage: annotation.payload.target.rectPage,
            rectViewport: annotation.payload.target.rectViewport
          }
        ]
  )
  void window.api.browser
    .setAnnotationViewportBridge({
      browserPageId: toolTargetId,
      emitViewport: pendingPayload !== null,
      enabled: surfaceActive && (pendingPayload !== null || markers.length > 0),
      markers,
      token
    })
    .catch(() => {
      // The viewport bridge is visual-only; stale markers beat breaking the surface on a destroyed guest.
    })
}
