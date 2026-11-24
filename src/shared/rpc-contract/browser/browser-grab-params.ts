import { z } from 'zod'
import { BrowserTarget } from '../rpc-param-primitives'
import {
  isValidBrowserAnnotationViewportBridgeMarkers,
  isValidBrowserAnnotationViewportBridgeToken,
  type BrowserAnnotationViewportBridgeMarker
} from '../../browser/annotations/browser-annotation-viewport-bridge'

const finite = z.number().finite()

export const GrabSetMode = BrowserTarget.extend({
  enabled: z.boolean(),
  requestId: z.string().min(1).max(200).optional()
})

export const GrabAwait = BrowserTarget.extend({
  opId: z.string().min(1).max(120),
  requestId: z.string().min(1).max(200).optional()
})

export const GrabCaptureSelection = BrowserTarget.extend({
  rect: z.object({ x: finite, y: finite, width: finite, height: finite }),
  // The pick to crop; a rectangle alone could name any region of the page.
  selectionId: z.string().min(1).max(200)
})

export const GrabViewportBridge = BrowserTarget.extend({
  enabled: z.boolean(),
  emitViewport: z.boolean(),
  markers: z.custom<BrowserAnnotationViewportBridgeMarker[]>(
    isValidBrowserAnnotationViewportBridgeMarkers,
    { message: 'Invalid annotation markers' }
  ),
  selectionId: z.string().max(80).optional(),
  token: z.custom<string>(isValidBrowserAnnotationViewportBridgeToken, {
    message: 'Invalid annotation bridge token'
  })
})

export const GrabCancel = BrowserTarget.extend({ requestId: z.string().min(1).max(200).optional() })
export const GrabPickedPresent = BrowserTarget.extend({
  selectionId: z.string().min(1).max(200),
  interactive: z.boolean().optional()
})
