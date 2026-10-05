import { useEffect, type RefObject } from 'react'

export function useBrowserPageWebviewPresentation(
  webviewRef: RefObject<Electron.WebviewTag | null>,
  inputLocked: boolean,
  showFailureOverlay: boolean
): void {
  useEffect(() => {
    const webview = webviewRef.current
    if (webview) {
      // Native guests can receive input beneath a renderer overlay.
      webview.style.pointerEvents = inputLocked ? 'none' : 'auto'
    }
  }, [inputLocked, webviewRef])

  useEffect(() => {
    const webview = webviewRef.current
    if (webview) {
      // Removing the guest from layout prevents native painting through the error UI.
      webview.style.display = showFailureOverlay ? 'none' : 'flex'
    }
  }, [showFailureOverlay, webviewRef])
}
