import type {
  BrowserGrabPayload,
  BrowserPageAnnotation
} from '../../../../../shared/browser-grab-types'

/**
 * Push the current annotation set into the guest, where badges render in-page so they track scroll
 * without a message per frame. Shared by every surface that annotates a guest — the payload is
 * derived only from the annotations themselves, so the two surfaces cannot disagree about it.
 */
export function syncGuestAnnotationViewportBridge({
  toolTargetId,
  annotations,
  pendingPayload,
  surfaceActive,
  token
}: {
  toolTargetId: string
  annotations: BrowserPageAnnotation[]
  pendingPayload: BrowserGrabPayload | null
  surfaceActive: boolean
  token: string
}): void {
  // Why: existing badges render in-guest for smooth scroll; only the pending dialog needs viewport messages.
  const markers = annotations.map((annotation, index) => ({
    id: annotation.id,
    index,
    isFixed: annotation.payload.target.isFixed === true,
    rectPage: annotation.payload.target.rectPage,
    rectViewport: annotation.payload.target.rectViewport
  }))
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
