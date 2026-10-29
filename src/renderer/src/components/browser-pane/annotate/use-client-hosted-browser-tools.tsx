import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { RuntimeBrowserClientPlacement } from '../../../../../shared/runtime-browser-placement'
import { isBlankBrowserUrl } from '@/lib/browser-palette-search'
import { BrowserGuestAnnotateOverlays } from './browser-guest-annotate-overlays'
import { useBrowserGuestTools } from './use-browser-guest-tools'
import { isPageDocumentNavigationStart } from '../host-guest/browser-page-webview-navigation-handlers'

export function useClientHostedBrowserTools({
  webviewRef,
  viewportRef,
  browserPageId,
  worktreeId,
  currentUrl,
  runtimeEnvironmentId,
  placement,
  isActive,
  unavailable,
  showFailureOverlay
}: {
  webviewRef: RefObject<Electron.WebviewTag | null>
  viewportRef: RefObject<HTMLDivElement | null>
  browserPageId: string
  worktreeId: string
  currentUrl: string
  runtimeEnvironmentId: string
  placement: RuntimeBrowserClientPlacement | null
  isActive: boolean
  unavailable: boolean
  showFailureOverlay: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null)
  const [documentVersion, setDocumentVersion] = useState(0)
  const disabled = !isActive || placement === null || unavailable || showFailureOverlay
  const browserHostClientId = placement?.browserHostClientId
  const browserHostGeneration = placement?.browserHostGeneration
  const pageHostGeneration = placement?.pageHostGeneration
  const markerIds = useAppStore((state) => state.browserAnnotationMarkerIdsByPageId[browserPageId])
  const tools = useBrowserGuestTools({
    browserPageId,
    worktreeId,
    guestId: placement ? String(pageHostGeneration) : null,
    webviewRef,
    containerRef,
    toolsReady: !disabled && !isBlankBrowserUrl(currentUrl),
    currentUrl,
    markerIds,
    documentVersion,
    annotateShortcut: true
  })
  const { markup, grabAnnotations, handleAnnotationViewportMessage, resetBrowserOverlayViewport } =
    tools
  const { cancel: cancelMarkup } = markup
  const { cancelPendingBrowserCapture } = grabAnnotations

  useLayoutEffect(() => {
    const parent = webviewRef.current?.parentElement
    const host = parent instanceof HTMLDivElement ? parent : viewportRef.current
    containerRef.current = host
    setOverlayHost(host)
  }, [
    webviewRef,
    viewportRef,
    browserPageId,
    runtimeEnvironmentId,
    browserHostClientId,
    browserHostGeneration,
    pageHostGeneration,
    unavailable
  ])

  useEffect(() => {
    return () => {
      cancelMarkup()
      cancelPendingBrowserCapture()
    }
  }, [
    browserPageId,
    runtimeEnvironmentId,
    browserHostClientId,
    browserHostGeneration,
    pageHostGeneration,
    disabled,
    cancelMarkup,
    cancelPendingBrowserCapture
  ])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || unavailable) {
      return
    }
    let documentUrl = currentUrl
    const invalidateDocument = (): void => {
      cancelPendingBrowserCapture()
      cancelMarkup()
      resetBrowserOverlayViewport()
      useAppStore.getState().invalidateBrowserPageAnnotationGeometry(browserPageId)
      setDocumentVersion((version) => version + 1)
    }
    const onStart = (event: Electron.DidStartNavigationEvent): void => {
      if (isPageDocumentNavigationStart(event)) {
        invalidateDocument()
        documentUrl = event.url
      }
    }
    const onNavigateInPage = (event: Electron.DidNavigateInPageEvent): void => {
      if (!event.isMainFrame) {
        return
      }
      if (documentUrl.split('#')[0] !== event.url.split('#')[0]) {
        invalidateDocument()
      }
      documentUrl = event.url
    }
    const onReady = (): void => setDocumentVersion((version) => version + 1)
    const onConsole = (event: Electron.ConsoleMessageEvent): void =>
      handleAnnotationViewportMessage(event)
    webview.addEventListener('did-start-navigation', onStart)
    webview.addEventListener('did-navigate-in-page', onNavigateInPage)
    webview.addEventListener('dom-ready', onReady)
    webview.addEventListener('console-message', onConsole)
    return () => {
      webview.removeEventListener('did-start-navigation', onStart)
      webview.removeEventListener('did-navigate-in-page', onNavigateInPage)
      webview.removeEventListener('dom-ready', onReady)
      webview.removeEventListener('console-message', onConsole)
    }
  }, [
    webviewRef,
    browserPageId,
    runtimeEnvironmentId,
    browserHostClientId,
    browserHostGeneration,
    pageHostGeneration,
    unavailable,
    currentUrl,
    cancelPendingBrowserCapture,
    cancelMarkup,
    handleAnnotationViewportMessage,
    resetBrowserOverlayViewport
  ])

  const showDrawing = !disabled && markup.isActive && markup.baseImage !== null
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    webview.style.display = showFailureOverlay || unavailable || showDrawing ? 'none' : 'flex'
    return () => {
      webview.style.display = 'flex'
    }
  }, [
    webviewRef,
    browserPageId,
    runtimeEnvironmentId,
    browserHostClientId,
    browserHostGeneration,
    pageHostGeneration,
    showFailureOverlay,
    unavailable,
    showDrawing
  ])

  return {
    ...tools,
    disabled,
    viewSource: {
      label: translate(
        'auto.components.browser.pane.BrowserPane.ec75d0c412',
        'Open browser devtools'
      ),
      onSelect: () => {
        void window.api.browser.openDevTools({ browserPageId })
      },
      disabled
    },
    overlay:
      !disabled && overlayHost
        ? createPortal(
            <BrowserGuestAnnotateOverlays
              {...tools}
              containerRef={containerRef}
              webviewRef={webviewRef}
              worktreeId={worktreeId}
              currentUrl={currentUrl}
            />,
            overlayHost
          )
        : null
  }
}
