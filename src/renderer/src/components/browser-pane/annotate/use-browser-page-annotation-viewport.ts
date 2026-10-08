import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import { EMPTY_BROWSER_ANNOTATIONS } from '../describe-page/browser-annotation-geometry'
import { syncGuestAnnotationViewportBridge } from './guest-annotation-viewport-bridge'

export type BrowserPageAnnotationBridge = {
  syncBrowserAnnotationViewportBridge: () => void
  invalidateBrowserAnnotationDocumentRef: MutableRefObject<() => void>
  annotationViewportBridgeTokenRef: MutableRefObject<string>
}

export function useBrowserPageAnnotationViewport({
  browserTabId,
  browserTabUrl,
  browserTabUrlRef,
  isActive,
  pendingAnnotationPayload,
  cancelPendingBrowserCapture
}: {
  browserTabId: string
  browserTabUrl: string
  browserTabUrlRef: MutableRefObject<string>
  isActive: boolean
  pendingAnnotationPayload: BrowserGrabPayload | null
  cancelPendingBrowserCapture: () => void
}): BrowserPageAnnotationBridge {
  const annotationViewportBridgeTokenRef = useRef<string>(undefined!)
  annotationViewportBridgeTokenRef.current ??= createBrowserUuid().replaceAll('-', '')
  const isActiveRef = useRef(isActive)
  const pendingAnnotationPayloadRef = useRef(pendingAnnotationPayload)
  const invalidatePendingCaptureRef = useRef(cancelPendingBrowserCapture)
  const browserAnnotations = useAppStore(
    (state) => state.browserAnnotationsByPageId[browserTabId] ?? EMPTY_BROWSER_ANNOTATIONS
  )
  const browserAnnotationMarkerIds = useAppStore(
    (state) => state.browserAnnotationMarkerIdsByPageId[browserTabId]
  )

  useLayoutEffect(() => {
    browserTabUrlRef.current = browserTabUrl
    isActiveRef.current = isActive
    pendingAnnotationPayloadRef.current = pendingAnnotationPayload
    invalidatePendingCaptureRef.current = cancelPendingBrowserCapture
  }, [
    browserTabUrl,
    browserTabUrlRef,
    cancelPendingBrowserCapture,
    isActive,
    pendingAnnotationPayload
  ])

  const syncBrowserAnnotationViewportBridge = useCallback((): void => {
    const state = useAppStore.getState()
    syncGuestAnnotationViewportBridge({
      toolTargetId: browserTabId,
      annotations: state.browserAnnotationsByPageId[browserTabId] ?? EMPTY_BROWSER_ANNOTATIONS,
      currentDocument: {
        markerIds: state.browserAnnotationMarkerIdsByPageId[browserTabId] ?? [],
        url: browserTabUrlRef.current
      },
      pendingPayload: pendingAnnotationPayloadRef.current,
      surfaceActive: isActiveRef.current,
      token: annotationViewportBridgeTokenRef.current
    })
  }, [browserTabId, browserTabUrlRef])

  const invalidateBrowserAnnotationDocument = useCallback((): void => {
    useAppStore.getState().invalidateBrowserPageAnnotationGeometry(browserTabId)
    invalidatePendingCaptureRef.current()
    pendingAnnotationPayloadRef.current = null
    syncBrowserAnnotationViewportBridge()
  }, [browserTabId, syncBrowserAnnotationViewportBridge])
  const invalidateBrowserAnnotationDocumentRef = useRef(invalidateBrowserAnnotationDocument)
  useLayoutEffect(() => {
    invalidateBrowserAnnotationDocumentRef.current = invalidateBrowserAnnotationDocument
  }, [invalidateBrowserAnnotationDocument])

  useEffect(() => {
    syncBrowserAnnotationViewportBridge()
  }, [
    browserAnnotations,
    browserAnnotationMarkerIds,
    browserTabId,
    browserTabUrl,
    isActive,
    pendingAnnotationPayload,
    syncBrowserAnnotationViewportBridge
  ])

  return {
    syncBrowserAnnotationViewportBridge,
    invalidateBrowserAnnotationDocumentRef,
    annotationViewportBridgeTokenRef
  }
}
