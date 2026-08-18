import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type {
  BrowserAnnotationIntent,
  BrowserGrabPayload
} from '../../../../../shared/browser-grab-types'
import { formatGrabPayloadAsText } from './GrabConfirmationSheet'
import type { GrabModeHook } from './useGrabMode'
import {
  createBrowserAnnotationId,
  createBrowserAnnotationPayload,
  DEFAULT_BROWSER_ANNOTATION_PRIORITY,
  type BrowserOverlayViewport
} from '../describe-page/browser-annotation-geometry'
import { runBrowserGrabActionShortcut } from './browser-page-grab-action'
import type { BrowserPageGrabToastState, GrabIntent } from '../describe-page/browser-page-types'
import {
  logGrabAnnotationAdded,
  logGrabElementSelected,
  type BrowserGrabRecorder
} from './browser-grab-recorder'
import { useBrowserPageOverlayViewportSync } from './use-browser-page-overlay-viewport-sync'
import { useBrowserPageGrabToast } from './use-browser-page-grab-toast'

const copiedGrabToastMessage = (): string =>
  translate(
    'auto.components.browser.pane.annotate.use.browser.page.grab.annotations.0c7b9b2b7a',
    'Copied'
  )
const screenshottedGrabToastMessage = (): string =>
  translate(
    'auto.components.browser.pane.annotate.use.browser.page.grab.annotations.c937229f19',
    'Screenshotted'
  )
const annotationAddedGrabToastMessage = (): string =>
  translate(
    'auto.components.browser.pane.annotate.use.browser.page.grab.annotations.1f5cb19034',
    'Annotation added'
  )

export function useBrowserPageGrabAnnotations({
  browserTabId,
  isActive,
  grab,
  containerRef,
  webviewRef,
  setBrowserOverlayViewport,
  browserAnnotationsLength,
  setBrowserAnnotationTrayOpen,
  recorder
}: {
  browserTabId: string
  isActive: boolean
  grab: GrabModeHook
  containerRef: MutableRefObject<HTMLDivElement | null>
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
  browserAnnotationsLength: number
  setBrowserAnnotationTrayOpen: Dispatch<SetStateAction<boolean>>
  recorder?: BrowserGrabRecorder
}): {
  grabIntent: GrabIntent
  startGrabIntent: (nextIntent: GrabIntent) => void
  pendingAnnotationPayload: BrowserGrabPayload | null
  setPendingAnnotationPayload: Dispatch<SetStateAction<BrowserGrabPayload | null>>
  grabToast: BrowserPageGrabToastState | null
  setGrabToast: Dispatch<SetStateAction<BrowserPageGrabToastState | null>>
  grabToastTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | undefined>
  dismissGrabToast: () => void
  handleGrabCopy: () => void
  handleGrabCopyScreenshot: () => void
  grabMenuActionTakenRef: MutableRefObject<boolean>
  handleAddBrowserAnnotation: (comment: string, intent: BrowserAnnotationIntent) => void
  handleCancelPendingBrowserAnnotation: () => void
  handleGrabActionShortcut: (key: 'c' | 's') => void
} {
  const browserTabIdRef = useRef(browserTabId)
  const [grabIntent, setGrabIntent] = useState<GrabIntent>('copy')
  const grabIntentRef = useRef(grabIntent)
  const [pendingAnnotationPayload, setPendingAnnotationPayload] =
    useState<BrowserGrabPayload | null>(null)
  const pendingAnnotationPayloadRef = useRef<BrowserGrabPayload | null>(null)
  const grabRef = useRef(grab)
  const grabPayloadRef = useRef(grab.payload)
  const toast = useBrowserPageGrabToast({
    containerRef,
    webviewRef,
    grabRef,
    grabIntentRef,
    pendingAnnotationPayloadRef
  })
  const { showGrabToast, dismissGrabToast } = toast

  useLayoutEffect(() => {
    browserTabIdRef.current = browserTabId
    grabIntentRef.current = grabIntent
    pendingAnnotationPayloadRef.current = pendingAnnotationPayload
    grabRef.current = grab
    grabPayloadRef.current = grab.payload
  }, [browserTabId, grab, grabIntent, pendingAnnotationPayload])
  // Why: Radix fires onOpenChange(false) before onSelect, so this flag lets onOpenChange skip the rearm that would clear the payload first.
  const grabMenuActionTakenRef = useRef(false)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const addBrowserPageAnnotation = useAppStore((s) => s.addBrowserPageAnnotation)

  useBrowserPageOverlayViewportSync({
    isActive,
    pendingAnnotationPayload,
    browserAnnotationsLength,
    containerRef,
    setBrowserOverlayViewport
  })

  // Why: the same in-guest picker powers two flows — Cmd/Ctrl+C copies, the toolbar action creates a pending annotation.
  useEffect(() => {
    if (grab.state !== 'confirming' || !grab.payload) {
      return
    }
    if (grabIntent === 'annotate') {
      // Why: the annotate flow skips the copy path below, but the pick itself
      // is still a user action — log it so pick → comment reads as one story.
      logGrabElementSelected(recorder, grab.payload)
      setPendingAnnotationPayload(grab.payload)
      return
    }
    // Why: log every picked element while recording — the requirement is "where
    // did the user click", so right-click picks are logged too, before the
    // context-menu action (copy/screenshot) runs.
    logGrabElementSelected(recorder, grab.payload)
    if (!grab.contextMenu) {
      if (recorder?.recordingRef.current) {
        // Why: while recording the pick is logged (above) but not copied.
        showGrabToast('Added to recording log', 'success', grab.payload)
      } else {
        const text = formatGrabPayloadAsText(grab.payload)
        void window.api.ui.writeClipboardText(text)
        recordFeatureInteraction('browser-grab')
        showGrabToast(copiedGrabToastMessage(), 'success', grab.payload)
      }
    }
  }, [
    grab.state,
    grab.payload,
    grab.contextMenu,
    grabIntent,
    recordFeatureInteraction,
    recorder,
    showGrabToast
  ])

  const startGrabIntent = useCallback(
    (nextIntent: GrabIntent): void => {
      recordFeatureInteraction('browser-grab')
      if (nextIntent === 'annotate') {
        recordFeatureInteraction('browser-annotations')
      }
      setGrabIntent(nextIntent)
      if (nextIntent === 'copy') {
        setPendingAnnotationPayload(null)
      } else if (recorder?.recordingRef.current) {
        // Why: while recording annotations land in the session log — keep the
        // annotations tray closed through the whole annotate flow.
        setBrowserAnnotationTrayOpen(false)
      } else {
        setBrowserAnnotationTrayOpen(true)
      }
      if (grab.state === 'idle' || grab.state === 'error' || grabIntent === nextIntent) {
        grab.toggle()
      }
    },
    [grab, grabIntent, recordFeatureInteraction, recorder, setBrowserAnnotationTrayOpen]
  )

  // C / S copy the hovered element without clicking: extract via IPC while armed/awaiting, else use the captured payload.
  const handleGrabActionShortcut = useCallback(
    (key: 'c' | 's'): void => {
      runBrowserGrabActionShortcut({
        key,
        grabIntent,
        grab,
        grabPayloadRef,
        browserTabIdRef,
        recordFeatureInteraction,
        showGrabToast,
        recorder
      })
    },
    [grab, grabIntent, recordFeatureInteraction, recorder, showGrabToast]
  )

  const handleGrabCopy = useCallback(() => {
    grabMenuActionTakenRef.current = true
    const payload = grabPayloadRef.current
    if (!payload) {
      return
    }
    if (recorder?.recordingRef.current) {
      showGrabToast('Added to recording log', 'success', payload)
      grab.rearm()
      return
    }
    const text = formatGrabPayloadAsText(payload)
    void window.api.ui.writeClipboardText(text)
    recordFeatureInteraction('browser-grab')
    showGrabToast(copiedGrabToastMessage(), 'success', payload)
    grab.rearm()
  }, [grab, recordFeatureInteraction, recorder, showGrabToast])

  const handleGrabCopyScreenshot = useCallback(() => {
    grabMenuActionTakenRef.current = true
    const payload = grabPayloadRef.current
    if (!payload) {
      return
    }
    if (recorder?.recordingRef.current) {
      showGrabToast('Added to recording log', 'success', payload)
      grab.rearm()
      return
    }
    const dataUrl = payload.screenshot?.dataUrl
    if (!dataUrl?.startsWith('data:image/png;base64,')) {
      return
    }
    void window.api.ui.writeClipboardImage(dataUrl)
    recordFeatureInteraction('browser-grab')
    showGrabToast(screenshottedGrabToastMessage(), 'success', payload)
    grab.rearm()
  }, [grab, recordFeatureInteraction, recorder, showGrabToast])

  const handleAddBrowserAnnotation = useCallback(
    (comment: string, intent: BrowserAnnotationIntent): void => {
      const payload = pendingAnnotationPayload
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
        payload: createBrowserAnnotationPayload(payload)
      })
      recordFeatureInteraction('browser-annotations')
      logGrabAnnotationAdded(recorder, payload, comment, intent)
      setPendingAnnotationPayload(null)
      if (recorder?.recordingRef.current) {
        // Why: while recording the annotation already lands in the session
        // log — keep the tray closed (it may have been open before) and
        // confirm via toast instead.
        setBrowserAnnotationTrayOpen(false)
        showGrabToast('Annotation added to recording log', 'success', payload)
      } else {
        setBrowserAnnotationTrayOpen(true)
        recordFeatureInteraction('browser-annotations')
        showGrabToast(annotationAddedGrabToastMessage(), 'success', payload)
      }
      grab.rearm()
    },
    [
      addBrowserPageAnnotation,
      browserTabId,
      grab,
      pendingAnnotationPayload,
      recordFeatureInteraction,
      recorder,
      setBrowserAnnotationTrayOpen,
      showGrabToast
    ]
  )

  const handleCancelPendingBrowserAnnotation = useCallback((): void => {
    setPendingAnnotationPayload(null)
    if (grabIntent === 'annotate' && grab.state === 'confirming') {
      grab.rearm()
    }
  }, [grab, grabIntent])

  return {
    grabIntent,
    startGrabIntent,
    pendingAnnotationPayload,
    setPendingAnnotationPayload,
    grabToast: toast.grabToast,
    setGrabToast: toast.setGrabToast,
    grabToastTimerRef: toast.grabToastTimerRef,
    dismissGrabToast,
    handleGrabCopy,
    handleGrabCopyScreenshot,
    grabMenuActionTakenRef,
    handleAddBrowserAnnotation,
    handleCancelPendingBrowserAnnotation,
    handleGrabActionShortcut
  }
}
