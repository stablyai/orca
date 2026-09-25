import { useCallback, useEffect, type RefObject } from 'react'
import { useAppStore } from '@/store'
import type { RuntimeBrowserClientPlacement } from '../../../../../shared/runtime-browser-placement'
import type { BrowserChromeMarkupTool } from '../assemble-chrome/browser-chrome-toolbar'
import { useBrowserGuestElementTools } from './use-browser-guest-element-tools'

/**
 * The browser tool cluster for a client-hosted page. Its `<webview>` is local, and main registers
 * it under the page id, so the picker and markup run exactly as on a local tab.
 */
export function useClientHostedBrowserGuestTools({
  browserPageId,
  worktreeId,
  webviewRef,
  viewportRef,
  runtimeEnvironmentId,
  placement,
  isActive,
  unavailable,
  showFailureOverlay
}: {
  browserPageId: string
  worktreeId: string
  webviewRef: RefObject<Electron.WebviewTag | null>
  viewportRef: RefObject<HTMLDivElement | null>
  runtimeEnvironmentId: string
  placement: RuntimeBrowserClientPlacement | null
  isActive: boolean
  unavailable: boolean
  showFailureOverlay: boolean
}): ReturnType<typeof useBrowserGuestElementTools> & {
  markupTool: BrowserChromeMarkupTool
  clearAnnotationsOnLoad: () => void
} {
  const disabled = !isActive || placement === null || unavailable || showFailureOverlay
  const tools = useBrowserGuestElementTools({
    browserPageId,
    // Why empty until placed: main registers the guest only once the host adopts the page.
    toolTargetId: placement === null ? '' : browserPageId,
    worktreeId,
    webviewRef,
    containerRef: viewportRef,
    toolsReady: !disabled
  })
  const { markup, grab, grabAnnotations } = tools
  const showOverlay = !disabled && markup.isActive && markup.baseImage !== null
  const browserHostClientId = placement?.browserHostClientId
  const browserHostGeneration = placement?.browserHostGeneration
  const pageHostGeneration = placement?.pageHostGeneration

  useEffect(() => {
    // Invalidate pending captures on deactivation, guest replacement, failure, or unmount.
    return markup.cancel
  }, [
    browserPageId,
    runtimeEnvironmentId,
    browserHostClientId,
    browserHostGeneration,
    pageHostGeneration,
    disabled,
    markup.cancel
  ])

  const grabActive = grab.state !== 'idle'
  const cancelGrab = grab.cancel
  useEffect(() => {
    // Why: an armed or confirming grab keeps its window-level C/S listener, so it must not outlive
    // an unusable pane.
    if (disabled && grabActive) {
      cancelGrab()
    }
  }, [cancelGrab, disabled, grabActive])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    // Why: the guest lives in a body-level fixed host that paints over the pane, so hide it only
    // after capture, or it would cover the drawing surface.
    webview.style.display = showFailureOverlay || unavailable || showOverlay ? 'none' : 'flex'
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
    showOverlay
  ])

  const clearBrowserPageAnnotations = useAppStore((s) => s.clearBrowserPageAnnotations)
  const { setPendingAnnotationPayload } = grabAnnotations
  const clearAnnotationsOnLoad = useCallback(() => {
    // Why: a load replaces the document, invalidating captured element rects — same as a local tab.
    clearBrowserPageAnnotations(browserPageId)
    setPendingAnnotationPayload(null)
    // Main settles an awaiting pick on navigation, but a confirming one would stay armed.
    if (grabActive) {
      cancelGrab()
    }
  }, [
    browserPageId,
    cancelGrab,
    clearBrowserPageAnnotations,
    grabActive,
    setPendingAnnotationPayload
  ])

  return {
    ...tools,
    markupTool: {
      active: markup.isActive,
      disabled: disabled || grabActive,
      onToggle: () => (markup.isActive ? markup.cancel() : void markup.start()),
      canShowDiscoveryHint: isActive
    },
    clearAnnotationsOnLoad
  }
}
