import { useCallback, useRef, type RefObject } from 'react'
import { acquireWebviewsDragPassthrough } from '../browser-pane/host-guest/webview-registry'
import { installTabDragMissedEndListeners } from './tab-drag-missed-end-listeners'

/** Own webview passthrough and missed-end fallback for the drag; release both when the root detaches. */
export function useTabDragGestureLifecycle({
  clearDragStateRef,
  tabDragActiveRef
}: {
  clearDragStateRef: RefObject<() => void>
  tabDragActiveRef: RefObject<boolean>
}): {
  acquireWebviewDragPassthrough: () => void
  installMissedEndFallback: () => void
  releaseMissedEndFallback: () => void
  releaseWebviewDragPassthrough: () => void
  setDragRootNode: (node: HTMLDivElement | null) => void
} {
  const releaseWebviewDragPassthroughRef = useRef<(() => void) | null>(null)
  const releaseMissedEndFallbackRef = useRef<(() => void) | null>(null)

  const releaseWebviewDragPassthrough = useCallback(() => {
    releaseWebviewDragPassthroughRef.current?.()
    releaseWebviewDragPassthroughRef.current = null
  }, [])

  const releaseMissedEndFallback = useCallback(() => {
    releaseMissedEndFallbackRef.current?.()
    releaseMissedEndFallbackRef.current = null
  }, [])

  const installMissedEndFallback = useCallback(() => {
    releaseMissedEndFallback()
    releaseMissedEndFallbackRef.current = installTabDragMissedEndListeners(() => {
      if (tabDragActiveRef.current) {
        clearDragStateRef.current()
      }
    })
  }, [clearDragStateRef, releaseMissedEndFallback, tabDragActiveRef])

  const acquireWebviewDragPassthrough = useCallback(() => {
    // Pointer-based dnd-kit drags bypass native drag listeners, so enable webview passthrough explicitly.
    releaseWebviewDragPassthrough()
    releaseWebviewDragPassthroughRef.current = acquireWebviewsDragPassthrough()
  }, [releaseWebviewDragPassthrough])

  const setDragRootNode = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node) {
        return
      }
      // Root teardown must release both webview passthrough and global missed-end listeners.
      releaseWebviewDragPassthrough()
      releaseMissedEndFallback()
    },
    [releaseMissedEndFallback, releaseWebviewDragPassthrough]
  )

  return {
    acquireWebviewDragPassthrough,
    installMissedEndFallback,
    releaseMissedEndFallback,
    releaseWebviewDragPassthrough,
    setDragRootNode
  }
}
