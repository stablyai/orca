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

/**
 * Back/Forward for the preview guest. In-preview navigation between workspace documents under the
 * same grant is allowed by the guest policy, so a report that links to a sibling page builds real
 * history — and fragments build in-document entries the same way a browser does.
 */
export function useDocPreviewWebviewHistory(
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
): DocPreviewHistory {
  const [depth, setDepth] = useState({ canGoBack: false, canGoForward: false })
  // Why a ref alongside state: sync fires per navigation event and would otherwise re-render on
  // every one, even though the buttons only change at the edges of history.
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
