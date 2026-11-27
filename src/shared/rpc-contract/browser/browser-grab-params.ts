import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { BrowserTarget } from '../rpc-param-primitives'
import {
  isValidBrowserAnnotationViewportBridgeMarkers,
  isValidBrowserAnnotationViewportBridgeToken,
  type BrowserAnnotationViewportBridgeMarker
} from '../../browser/annotations/browser-annotation-viewport-bridge'

const finite = lazyZodSchema(() => z.number().finite())

export const GrabSetMode = lazyZodSchema(() =>
  BrowserTarget.extend({
    enabled: z.boolean(),
    requestId: z.string().min(1).max(200).optional()
  })
)

export const GrabAwait = lazyZodSchema(() =>
  BrowserTarget.extend({
    opId: z.string().min(1).max(120),
    requestId: z.string().min(1).max(200).optional()
  })
)

export const GrabCaptureSelection = lazyZodSchema(() =>
  BrowserTarget.extend({
    rect: z.object({ x: finite, y: finite, width: finite, height: finite }),
    // The pick to crop; a rectangle alone could name any region of the page.
    selectionId: z.string().min(1).max(200)
  })
)

export const GrabViewportBridge = lazyZodSchema(() =>
  BrowserTarget.extend({
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
)

export const GrabCancel = lazyZodSchema(() =>
  BrowserTarget.extend({ requestId: z.string().min(1).max(200).optional() })
)
export const GrabPickedPresent = lazyZodSchema(() =>
  BrowserTarget.extend({
    selectionId: z.string().min(1).max(200),
    interactive: z.boolean().optional()
  })
)
