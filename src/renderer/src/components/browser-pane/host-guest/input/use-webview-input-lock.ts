import { useEffect, type MutableRefObject } from 'react'
import { registerWebviewDragPassthroughSurface } from '../drag/webview-drag-passthrough'

/**
 * Keeps the page's own hit testing off while input is locked.
 * Why: Electron webviews keep receiving native input under a React overlay unless their own hit testing is disabled.
 */
export function useWebviewInputLock(
  webviewRef: MutableRefObject<Electron.WebviewTag | null>,
  inputLocked: boolean
): void {
  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    const applyLock = (): void => {
      webview.style.pointerEvents = inputLocked ? 'none' : 'auto'
    }
    applyLock()
    // A drag that started before the lock changed restores the old value on release; re-apply the current lock.
    return registerWebviewDragPassthroughSurface((passthrough) => {
      if (!passthrough) {
        applyLock()
      }
    })
  }, [inputLocked, webviewRef])
}
