import { useEffect, type RefObject } from 'react'
import type { RuntimeBrowserClientPlacement } from '../../../../../../shared/browser/client-hosting/runtime-browser-placement'
import type { BrowserChromeMarkupTool } from '../../assemble-chrome/toolbar/browser-annotate-tool-button'
import { MarkupOverlay } from '../MarkupOverlay'
import { useBrowserPageMarkupCapture } from './use-browser-page-markup-capture'

export function useClientHostedBrowserMarkup({
  webviewRef,
  browserPageId,
  runtimeEnvironmentId,
  placement,
  isActive,
  unavailable,
  showFailureOverlay,
  controlsContainer
}: {
  webviewRef: RefObject<Electron.WebviewTag | null>
  browserPageId: string
  runtimeEnvironmentId: string
  placement: RuntimeBrowserClientPlacement | null
  isActive: boolean
  unavailable: boolean
  showFailureOverlay: boolean
  /** A footer for the drawing controls while a preset box, which can outgrow the pane, holds the drawing. */
  controlsContainer: HTMLElement | null
}) {
  const markup = useBrowserPageMarkupCapture(webviewRef)
  const disabled = !isActive || placement === null || unavailable || showFailureOverlay
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

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    // Hide the retained native layer only after capture, so it cannot cover the drawing surface.
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

  const tool: BrowserChromeMarkupTool = {
    active: markup.isActive,
    disabled,
    onToggle: () => (markup.isActive ? markup.cancel() : void markup.start()),
    canShowDiscoveryHint: isActive
  }
  return {
    tool,
    overlay:
      showOverlay && markup.baseImage ? (
        <MarkupOverlay
          baseImage={markup.baseImage}
          busy={markup.state === 'composing'}
          onComplete={(input) => void markup.complete(input)}
          onCancel={markup.cancel}
          controlsContainer={controlsContainer}
        />
      ) : null
  }
}
