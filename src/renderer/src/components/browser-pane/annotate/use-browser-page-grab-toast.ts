import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import type { BrowserPageGrabToastState } from '../describe-page/browser-page-types'
import type { GrabModeHook } from './useGrabMode'

// Inline toast near the grabbed element (below, or above near the viewport
// bottom) so it doesn't occlude the selection. Owned by the grab flow so the
// context menu, shortcuts, and annotation add all confirm the same way.
export function useBrowserPageGrabToast({
  containerRef,
  webviewRef,
  grabRef,
  grabIntentRef,
  pendingAnnotationPayloadRef
}: {
  containerRef: MutableRefObject<HTMLDivElement | null>
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  grabRef: MutableRefObject<GrabModeHook>
  grabIntentRef: MutableRefObject<string>
  pendingAnnotationPayloadRef: MutableRefObject<BrowserGrabPayload | null>
}): {
  grabToast: BrowserPageGrabToastState | null
  setGrabToast: Dispatch<SetStateAction<BrowserPageGrabToastState | null>>
  grabToastTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | undefined>
  dismissGrabToast: () => void
  showGrabToast: (
    message: string,
    type: 'success' | 'error',
    payload?: BrowserGrabPayload | null
  ) => void
} {
  const grabToastTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [grabToast, setGrabToast] = useState<BrowserPageGrabToastState | null>(null)

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
  }, [grabIntentRef, grabRef, pendingAnnotationPayloadRef])

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

  return {
    grabToast,
    setGrabToast,
    grabToastTimerRef,
    dismissGrabToast,
    showGrabToast
  }
}
