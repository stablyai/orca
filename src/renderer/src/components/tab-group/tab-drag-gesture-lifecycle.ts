import { useCallback, useRef, type RefObject } from 'react'
import { acquireWebviewsDragPassthrough } from '../browser-pane/host-guest/webview-registry'
import { installTabDragMissedEndListeners } from './tab-drag-missed-end-listeners'

/** Global side effects a tab drag holds while in flight: webview pointer
 *  passthrough plus the window-level fallback for a missed drag end. Both refs
 *  are injected so this stays independent of the drag state machine. */
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
    // Why: dnd-kit tab drags are pointer-driven, so the native drag listeners
    // in webview-registry never fire. Put webviews in passthrough explicitly.
    releaseWebviewDragPassthrough()
    releaseWebviewDragPassthroughRef.current = acquireWebviewsDragPassthrough()
  }, [releaseWebviewDragPassthrough])

  const setDragRootNode = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node) {
        return
      }
      // Why: this root owns the dnd-kit gesture that temporarily puts browser
      // webviews in pointer passthrough and installs global fallback listeners,
      // so root teardown must release both.
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
