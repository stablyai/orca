import { useCallback, useRef, useState, type MutableRefObject } from 'react'

export type DocPreviewHistory = {
  canGoBack: boolean
  canGoForward: boolean
  goBack: () => void
  goForward: () => void
  /** Re-read the guest's history depth; call from every navigation event. */
  sync: () => void
  /** Forget the old guest's depth when the preview re-mints and re-attaches. */
  reset: () => void
}

/** Track full and fragment navigations allowed within one grant as ordinary browser history. */
export function useDocPreviewWebviewHistory(
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
): DocPreviewHistory {
  const [depth, setDepth] = useState({ canGoBack: false, canGoForward: false })
  // Compare against a ref so navigation events re-render only when history button availability changes.
  const depthRef = useRef(depth)

  const apply = useCallback((next: { canGoBack: boolean; canGoForward: boolean }): void => {
    if (
      depthRef.current.canGoBack === next.canGoBack &&
      depthRef.current.canGoForward === next.canGoForward
    ) {
      return
    }
    depthRef.current = next
    setDepth(next)
  }, [])

  const sync = useCallback((): void => {
    const webview = webviewRef.current
    if (!webview) {
      apply({ canGoBack: false, canGoForward: false })
      return
    }
    try {
      apply({ canGoBack: webview.canGoBack(), canGoForward: webview.canGoForward() })
    } catch {
      // The guest can detach between the event and this read; treat it as no history.
      apply({ canGoBack: false, canGoForward: false })
    }
  }, [apply, webviewRef])

  const reset = useCallback((): void => {
    apply({ canGoBack: false, canGoForward: false })
  }, [apply])

  const goBack = useCallback((): void => {
    try {
      webviewRef.current?.goBack()
    } catch {
      /* detached guest */
    }
  }, [webviewRef])

  const goForward = useCallback((): void => {
    try {
      webviewRef.current?.goForward()
    } catch {
      /* detached guest */
    }
  }, [webviewRef])

  return {
    canGoBack: depth.canGoBack,
    canGoForward: depth.canGoForward,
    goBack,
    goForward,
    sync,
    reset
  }
}
