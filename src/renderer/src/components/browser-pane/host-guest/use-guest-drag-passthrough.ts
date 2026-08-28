import { useEffect, type MutableRefObject } from 'react'
import { useWebviewDragPassthroughActive } from './use-webview-drag-passthrough-active'

/**
 * Enrols a single component-owned guest in the renderer's drag passthrough.
 *
 * Why it matters: a `<webview>` swallows the pointer stream the document never sees, so a
 * dnd-kit drag stops receiving `pointermove` the instant the cursor crosses one — the dragged
 * tab stops following the cursor and the drop it was aiming for cannot be made. The browser
 * pane's guests are held click-through through their registry; a guest that belongs to one
 * component instead (the document preview) has no registry to be walked by, so it enrols here.
 */
export function useGuestDragPassthrough(
  webviewRef: MutableRefObject<Electron.WebviewTag | null>,
  /** Changes when the ref is pointed at a new guest, so one attached mid-drag is settled too. */
  guestKey: string | null
): void {
  const passthroughActive = useWebviewDragPassthroughActive()

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    webview.style.pointerEvents = passthroughActive ? 'none' : ''
    return () => {
      // Why reset rather than restore: the guest outlives this state, and leaving it transparent
      // would cost the reader every click on the document.
      webview.style.pointerEvents = ''
    }
  }, [guestKey, passthroughActive, webviewRef])
}
