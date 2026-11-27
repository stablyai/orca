import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { BrowserTarget } from '../rpc-param-primitives'
import {
  isValidBrowserAnnotationViewportBridgeMarkers,
  isValidBrowserAnnotationViewportBridgeToken,
  type BrowserAnnotationViewportBridgeMarker
} from '../../browser/annotations/browser-annotation-viewport-bridge'

const finite = lazyZodSchema(() => z.number().finite())

export const GrabSetMode = BrowserTarget.extend({
  enabled: z.boolean()
})

export const GrabAwait = BrowserTarget.extend({
  opId: z.string().min(1).max(120)
})

export const GrabCaptureSelection = BrowserTarget.extend({
  rect: z.object({ x: finite, y: finite, width: finite, height: finite })
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
