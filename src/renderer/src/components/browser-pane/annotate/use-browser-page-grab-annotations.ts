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
  setBrowserAnnotationTrayOpen
}: {
  browserTabId: string
  isActive: boolean
  grab: GrabModeHook
  containerRef: MutableRefObject<HTMLDivElement | null>
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
  browserAnnotationsLength: number
  setBrowserAnnotationTrayOpen: Dispatch<SetStateAction<boolean>>
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
  const grabToastTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [grabIntent, setGrabIntent] = useState<GrabIntent>('copy')
  const grabIntentRef = useRef(grabIntent)
  const [pendingAnnotationPayload, setPendingAnnotationPayload] =
    useState<BrowserGrabPayload | null>(null)
  const pendingAnnotationPayloadRef = useRef<BrowserGrabPayload | null>(null)
  // Inline toast near the grabbed element (below, or above near the viewport bottom) so it doesn't occlude the selection.
  const [grabToast, setGrabToast] = useState<BrowserPageGrabToastState | null>(null)
  const grabRef = useRef(grab)
  const grabPayloadRef = useRef(grab.payload)

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

  useEffect(() => {
    return () => {
      clearTimeout(grabToastTimerRef.current)
    }
  }, [])

  const dismissGrabToast = useCallback(() => {
    clearTimeout(grabToastTimerRef.current)
    setGrabToast(null)
    // Why: only rearm while 'confirming'; if a C/S shortcut already rearmed (state 'armed'), skip to avoid a double-rearm race.
    if (
      grabRef.current.state === 'confirming' &&
      !(grabIntentRef.current === 'annotate' && pendingAnnotationPayloadRef.current)
    ) {
      grabRef.current.rearm()
    }
  }, [])

  const showGrabToast = useCallback(
    (message: string, type: 'success' | 'error', payload?: BrowserGrabPayload | null) => {
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
        // Show below the element unless it's too close to the bottom edge
        below = elementBottom + 52 < containerHeight
        y = below ? elementBottom : elementTop
      } else if (containerRect) {
        x = containerRect.width / 2
        y = containerRect.height / 2
      }
      clearTimeout(grabToastTimerRef.current)
      setGrabToast({ message, type, x, y, below, payload: payload ?? null })
      grabToastTimerRef.current = setTimeout(() => dismissGrabToast(), 2000)
    },
    [containerRef, dismissGrabToast, webviewRef]
  )

  // Why: the same in-guest picker powers two flows — Cmd/Ctrl+C copies, the toolbar action creates a pending annotation.
  useEffect(() => {
    if (grab.state !== 'confirming' || !grab.payload) {
      return
    }
    if (grabIntent === 'annotate') {
      setPendingAnnotationPayload(grab.payload)
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
    showGrabToast
  ])

  useEffect(() => {
    if (!isActive || (!pendingAnnotationPayload && browserAnnotationsLength === 0)) {
      return
    }

    const observedContainer = containerRef.current
    const resizeObserver =
      typeof ResizeObserver === 'undefined' || !observedContainer
        ? null
        : new ResizeObserver(() => {
            setBrowserOverlayViewport((current) => ({ ...current, version: current.version + 1 }))
          })
    if (resizeObserver && observedContainer) {
      resizeObserver.observe(observedContainer)
    }

    return () => {
      resizeObserver?.disconnect()
    }
  }, [
    browserAnnotationsLength,
    containerRef,
    isActive,
    pendingAnnotationPayload,
    setBrowserOverlayViewport
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
      } else {
        setBrowserAnnotationTrayOpen(true)
      }
      if (grab.state === 'idle' || grab.state === 'error' || grabIntent === nextIntent) {
        grab.toggle()
      }
    },
    [grab, grabIntent, recordFeatureInteraction, setBrowserAnnotationTrayOpen]
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
        showGrabToast
      })
    },
    [grab, grabIntent, recordFeatureInteraction, showGrabToast]
  )

  const handleGrabCopy = useCallback(() => {
    grabMenuActionTakenRef.current = true
    const payload = grabPayloadRef.current
    if (!payload) {
      return
    }
    const text = formatGrabPayloadAsText(payload)
    void window.api.ui.writeClipboardText(text)
    recordFeatureInteraction('browser-grab')
    showGrabToast(copiedGrabToastMessage(), 'success', payload)
    grab.rearm()
  }, [grab, recordFeatureInteraction, showGrabToast])

  const handleGrabCopyScreenshot = useCallback(() => {
    grabMenuActionTakenRef.current = true
    const payload = grabPayloadRef.current
    if (!payload) {
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
  }, [grab, recordFeatureInteraction, showGrabToast])

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
      setPendingAnnotationPayload(null)
      setBrowserAnnotationTrayOpen(true)
      showGrabToast(annotationAddedGrabToastMessage(), 'success', payload)
      grab.rearm()
    },
    [
      addBrowserPageAnnotation,
      browserTabId,
      grab,
      pendingAnnotationPayload,
      recordFeatureInteraction,
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
    grabToast,
    setGrabToast,
    grabToastTimerRef,
    dismissGrabToast,
    handleGrabCopy,
    handleGrabCopyScreenshot,
    grabMenuActionTakenRef,
    handleAddBrowserAnnotation,
    handleCancelPendingBrowserAnnotation,
    handleGrabActionShortcut
  }
}
