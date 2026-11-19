import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store/index'
import { imageCopyFailedMessage } from '@/lib/clipboard/images/clipboard-image-copy'
import {
  isBrowserAnnotationPageFull,
  type BrowserAnnotationIntent,
  type BrowserGrabPayload,
  type GrabIntent
} from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { formatGrabPayloadAsText } from './GrabConfirmationSheet'
import { browserAnnotationLimitMessage } from '../delivery/browser-annotation-limit-message'
import {
  createBrowserAnnotationId,
  createBrowserAnnotationPayload,
  DEFAULT_BROWSER_ANNOTATION_PRIORITY
} from '../../describe-page/browser-annotation-geometry'
import { useBrowserPageAnnotationViewportTracking } from '../viewport/use-browser-page-annotation-viewport-tracking'
import { grabHoverStillCurrent, runBrowserGrabActionShortcut } from './browser-page-grab-action'
import {
  annotationAddedGrabToastMessage,
  copiedGrabToastMessage,
  screenshottedGrabToastMessage
} from './grab-toast-messages'
import { useGrabScreenshotCopy } from '../capture/use-grab-screenshot-copy'
import { useGrabCopyHandlers } from './use-grab-copy-handlers'
import type {
  BrowserPageGrabAnnotations,
  BrowserPageGrabAnnotationsOptions,
  BrowserPageGrabToastState
} from '../../describe-page/browser-page-types'

export function useBrowserPageGrabAnnotations({
  browserTabId,
  toolTargetId = browserTabId,
  isActive,
  grab,
  containerRef,
  trackingContainer,
  trackingScroller,
  webviewRef,
  setBrowserOverlayViewport,
  browserAnnotationsLength
}: BrowserPageGrabAnnotationsOptions): BrowserPageGrabAnnotations {
  const mountedRef = useMountedRef()
  const toolTargetIdRef = useRef(toolTargetId)
  const grabToastTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [grabIntent, setGrabIntent] = useState<GrabIntent>('copy')
  const grabIntentRef = useRef(grabIntent)
  const [pendingAnnotationPayload, setPendingAnnotationPayload] =
    useState<BrowserGrabPayload | null>(null)
  const pendingAnnotationPayloadRef = useRef<BrowserGrabPayload | null>(null)
  const grabSessionRef = useRef(0)
  const grabIdle = grab.state === 'idle'
  const { claimGrabToast, copyGrabScreenshot } = useGrabScreenshotCopy()
  useLayoutEffect(() => {
    grabSessionRef.current += 1
    // A screenshot copy still writing to the clipboard belongs to the session it started in; its toast is stale now.
    claimGrabToast()
  }, [claimGrabToast, grabIdle, grabIntent, toolTargetId])
  // Every way out of picking (Done, Esc, the toolbar, navigation) ends here: an unsaved comment card can't outlive it.
  if (grab.state === 'idle' && pendingAnnotationPayload !== null) {
    setPendingAnnotationPayload(null)
  }
  // Place the toast beside the selected element without covering it.
  const [grabToast, setGrabToast] = useState<BrowserPageGrabToastState | null>(null)
  const grabRef = useRef(grab)
  const grabPayloadRef = useRef(grab.payload)
  const browserAnnotationsLengthRef = useRef(browserAnnotationsLength)

  useLayoutEffect(() => {
    browserAnnotationsLengthRef.current = browserAnnotationsLength
    toolTargetIdRef.current = toolTargetId
    grabIntentRef.current = grabIntent
    pendingAnnotationPayloadRef.current = pendingAnnotationPayload
    grabRef.current = grab
    grabPayloadRef.current = grab.payload
  }, [browserAnnotationsLength, grab, grabIntent, pendingAnnotationPayload, toolTargetId])
  // Why: Radix fires onOpenChange(false) before onSelect, so this flag lets onOpenChange skip the rearm that would clear the payload first.
  const grabMenuActionTakenRef = useRef(false)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const addBrowserPageAnnotation = useAppStore((s) => s.addBrowserPageAnnotation)

  useEffect(() => () => clearTimeout(grabToastTimerRef.current), [])

  const dismissGrabToast = useCallback(() => {
    claimGrabToast()
    clearTimeout(grabToastTimerRef.current)
    setGrabToast(null)
    // Why: only rearm while 'confirming'; if a C/S shortcut already rearmed (state 'armed'), skip to avoid a double-rearm race.
    if (
      grabRef.current.state === 'confirming' &&
      !(grabIntentRef.current === 'annotate' && pendingAnnotationPayloadRef.current)
    ) {
      grabRef.current.rearm()
    }
  }, [claimGrabToast])

  const showGrabToast = useCallback(
    (message: string, type: 'success' | 'error', payload?: BrowserGrabPayload | null) => {
      if (!mountedRef.current) {
        return
      }
      let x = 0
      let y = 0
      let below = true
      const containerRect = containerRef.current?.getBoundingClientRect()
      if (payload) {
        const rect = payload.target.rectViewport
        const webview = webviewRef.current
        const webviewRect = webview?.getBoundingClientRect()
        const offsetX = (webviewRect?.left ?? 0) - (containerRect?.left ?? 0)
        const offsetY = (webviewRect?.top ?? 0) - (containerRect?.top ?? 0)
        x = offsetX + rect.x + rect.width / 2
        const elementBottom = offsetY + rect.y + rect.height
        const elementTop = offsetY + rect.y
        const containerHeight = containerRect?.height ?? 0
        below = elementBottom + 52 < containerHeight
        y = below ? elementBottom : elementTop
      } else if (containerRect) {
        x = containerRect.width / 2
        y = containerRect.height / 2
      }
      claimGrabToast()
      clearTimeout(grabToastTimerRef.current)
      setGrabToast({ message, type, x, y, below, payload: payload ?? null })
      grabToastTimerRef.current = setTimeout(() => dismissGrabToast(), 2000)
    },
    [claimGrabToast, containerRef, dismissGrabToast, mountedRef, webviewRef]
  )

  const showGrabScreenshotToast = useCallback(
    (copied: boolean, payload: BrowserGrabPayload): void =>
      copied
        ? showGrabToast(screenshottedGrabToastMessage(), 'success', payload)
        : showGrabToast(imageCopyFailedMessage(), 'error', payload),
    [showGrabToast]
  )

  // The picker supports clipboard copying and independently dismissible annotation drafts.
  useEffect(() => {
    if (grab.state !== 'confirming' || !grab.payload) {
      return
    }
    if (grabIntent === 'annotate') {
      // The store refuses notes past the cap, so say so before the user writes one.
      if (
        grabPayloadRef.current === grab.payload &&
        isBrowserAnnotationPageFull(browserAnnotationsLengthRef.current)
      ) {
        showGrabToast(browserAnnotationLimitMessage(), 'error', grab.payload)
        return
      }
      // Loading may cancel the selection before React accepts this pending snapshot.
      setPendingAnnotationPayload(() =>
        grabPayloadRef.current === grab.payload ? grab.payload : null
      )
      // The live box measured for the previous selection must not place this one's card.
      setBrowserOverlayViewport((current) =>
        current.target ? { ...current, target: undefined } : current
      )
      return
    }
    if (!grab.contextMenu) {
      const text = formatGrabPayloadAsText(grab.payload)
      void window.api.ui.writeClipboardText(text)
      recordFeatureInteraction('browser-grab')
      showGrabToast(copiedGrabToastMessage(), 'success', grab.payload)
    }
  }, [
    grab.state,
    grab.payload,
    grab.contextMenu,
    grabIntent,
    recordFeatureInteraction,
    setBrowserOverlayViewport,
    showGrabToast
  ])

  useBrowserPageAnnotationViewportTracking({
    isActive,
    pendingAnnotation: pendingAnnotationPayload,
    annotationCount: browserAnnotationsLength,
    container: trackingContainer ?? containerRef.current,
    scroller:
      trackingScroller ??
      containerRef.current?.querySelector<HTMLDivElement>('[data-browser-page-scroller]') ??
      null,
    setBrowserOverlayViewport
  })

  const startGrabIntent = useCallback(
    (nextIntent: GrabIntent): void => {
      recordFeatureInteraction('browser-grab')
      if (nextIntent === 'annotate') {
        recordFeatureInteraction('browser-annotations')
      }
      if (grabIntent !== nextIntent) {
        // The last tool's feedback (and the rearm its timer would do) must not land on the new tool's pick.
        claimGrabToast()
        clearTimeout(grabToastTimerRef.current)
        setGrabToast(null)
      }
      if (grab.state === 'confirming' && grabIntent !== nextIntent) {
        // Why rearm: the intent effect would otherwise treat the held pick as a new one under the new intent
        // (copy it, or open a comment card for it). Rearm drops the pick and keeps picking.
        pendingAnnotationPayloadRef.current = null
        setPendingAnnotationPayload(null)
        setGrabIntent(nextIntent)
        grab.rearm()
        return
      }
      setGrabIntent(nextIntent)
      if (nextIntent === 'copy') {
        setPendingAnnotationPayload(null)
      }
      if (grab.state === 'idle' || grab.state === 'error' || grabIntent === nextIntent) {
        grab.toggle()
      }
    },
    [claimGrabToast, grab, grabIntent, recordFeatureInteraction]
  )

  // C / S copy the hovered element without clicking: extract via IPC while armed/awaiting, else use the captured payload.
  const handleGrabActionShortcut = useCallback(
    (key: 'c' | 's'): void => {
      runBrowserGrabActionShortcut({
        // A hover read resolves later; drop it if the user left Grab or the page changed meanwhile.
        isStillCurrent: grabHoverStillCurrent(grabSessionRef, mountedRef),
        key,
        grabIntent,
        grab,
        grabPayloadRef,
        toolTargetIdRef,
        recordFeatureInteraction,
        showGrabToast,
        copyGrabScreenshot: (dataUrl, payload) =>
          copyGrabScreenshot(dataUrl, (copied) => showGrabScreenshotToast(copied, payload))
      })
    },
    [
      copyGrabScreenshot,
      grab,
      grabIntent,
      mountedRef,
      recordFeatureInteraction,
      showGrabScreenshotToast,
      showGrabToast
    ]
  )

  const { handleGrabCopy, handleGrabCopyScreenshot } = useGrabCopyHandlers({
    grab,
    grabPayloadRef,
    grabMenuActionTakenRef,
    recordFeatureInteraction,
    showGrabToast,
    showGrabScreenshotToast,
    copyGrabScreenshot,
    copiedMessage: copiedGrabToastMessage
  })

  const handleAddBrowserAnnotation = useCallback(
    (comment: string, intent: BrowserAnnotationIntent, imagePaths: string[] = []): void => {
      const payload = pendingAnnotationPayloadRef.current
      if (!payload) {
        return
      }
      addBrowserPageAnnotation({
        id: createBrowserAnnotationId(),
        browserPageId: browserTabId,
        comment,
        intent,
        priority: DEFAULT_BROWSER_ANNOTATION_PRIORITY,
        createdAt: new Date().toISOString(),
        payload: createBrowserAnnotationPayload(payload),
        ...(imagePaths.length > 0 ? { imagePaths } : {})
      })
      recordFeatureInteraction('browser-annotations')
      pendingAnnotationPayloadRef.current = null
      setPendingAnnotationPayload(null)
      showGrabToast(annotationAddedGrabToastMessage(), 'success', payload)
      grab.rearm()
    },
    [addBrowserPageAnnotation, browserTabId, grab, recordFeatureInteraction, showGrabToast]
  )

  const handleCancelPendingBrowserAnnotation = useCallback((): void => {
    pendingAnnotationPayloadRef.current = null
    setPendingAnnotationPayload(null)
    if (grabIntent === 'annotate' && grab.state === 'confirming') {
      grab.rearm()
    }
  }, [grab, grabIntent])

  const cancelPendingBrowserCapture = useCallback((): void => {
    claimGrabToast()
    grabRef.current.cancel()
    pendingAnnotationPayloadRef.current = null
    grabPayloadRef.current = null
    setPendingAnnotationPayload(null)
    clearTimeout(grabToastTimerRef.current)
    setGrabToast(null)
  }, [claimGrabToast])

  return {
    grabIntent,
    startGrabIntent,
    pendingAnnotationPayload,
    setPendingAnnotationPayload,
    grabToast,
    setGrabToast,
    grabToastTimerRef,
    dismissGrabToast,
    copyGrabScreenshot,
    handleGrabCopy,
    handleGrabCopyScreenshot,
    grabMenuActionTakenRef,
    handleAddBrowserAnnotation,
    handleCancelPendingBrowserAnnotation,
    cancelPendingBrowserCapture,
    handleGrabActionShortcut
  }
}
