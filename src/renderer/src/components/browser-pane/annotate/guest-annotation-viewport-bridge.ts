import type {
  BrowserGrabPayload,
  BrowserPageAnnotation
} from '../../../../../shared/browser-grab-types'
import { browserAnnotationMatchesPageUrl } from './browser-annotation-page-url'

// Guest-rendered badges track scrolling without a renderer message per frame.
export function syncGuestAnnotationViewportBridge({
  toolTargetId,
  annotations,
  currentDocument,
  pendingPayload,
  surfaceActive,
  token
}: {
  toolTargetId: string
  annotations: BrowserPageAnnotation[]
  currentDocument?: { markerIds: readonly string[]; url: string }
  pendingPayload: BrowserGrabPayload | null
  surfaceActive: boolean
  token: string
}): void {
  // Why: existing badges render in-guest for smooth scroll; only the pending dialog needs viewport messages.
  const eligibleIds = currentDocument ? new Set(currentDocument.markerIds) : null
  // Keep tray numbering even when earlier notes belong to retired documents.
  const markers = annotations.flatMap((annotation, index) =>
    currentDocument &&
    (!eligibleIds?.has(annotation.id) ||
      !browserAnnotationMatchesPageUrl(annotation.payload.page.sanitizedUrl, currentDocument.url))
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
