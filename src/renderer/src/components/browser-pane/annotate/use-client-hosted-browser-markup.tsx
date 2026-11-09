import { useEffect, type RefObject } from 'react'
import type { RuntimeBrowserClientPlacement } from '../../../../../shared/runtime-browser-placement'
import { MarkupDrawButton } from './MarkupDrawButton'
import { MarkupOverlay } from './MarkupOverlay'
import { useBrowserPageMarkupCapture } from './use-browser-page-markup-capture'

export function useClientHostedBrowserMarkup({
  webviewRef,
  browserPageId,
  runtimeEnvironmentId,
  placement,
  isActive,
  unavailable,
  showFailureOverlay
}: {
  webviewRef: RefObject<Electron.WebviewTag | null>
  browserPageId: string
  runtimeEnvironmentId: string
  placement: RuntimeBrowserClientPlacement | null
  isActive: boolean
  unavailable: boolean
  showFailureOverlay: boolean
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

  return {
    drawButton: (
      <MarkupDrawButton
        onClick={() => (markup.isActive ? markup.cancel() : void markup.start())}
        disabled={disabled}
        active={markup.isActive}
        surfaceActive={isActive}
      />
    ),
    overlay:
      showOverlay && markup.baseImage ? (
        <MarkupOverlay
          baseImage={markup.baseImage}
          busy={markup.state === 'composing'}
          onComplete={(input) => void markup.complete(input)}
          onCancel={markup.cancel}
        />
      ) : null
  }
}
