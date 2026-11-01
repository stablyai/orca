import { useEffect, useState } from 'react'
import { hasVisibleOverlayOver } from '@/lib/visible-overlay'
import { registerBrowserClientPagePositionSync } from '../browser-client-page-position-driver'
import { isWebviewDragPassthroughActive } from '../host-guest/webview-drag-passthrough'

export type BrowserDevToolsDockSnapshot = { url: string; width: number; height: number }

/** Keeps docked DevTools, a native view painted above all HTML, over `placeholder`. While Orca
 *  UI is drawn over that area or a drag needs the pointer, the view hides and its last frame is
 *  returned for the placeholder to paint instead. */
export function useBrowserDevToolsDockBounds(
  browserPageId: string,
  placeholder: HTMLElement | null
): BrowserDevToolsDockSnapshot | null {
  const [snapshot, setSnapshot] = useState<BrowserDevToolsDockSnapshot | null>(null)
  useEffect(() => {
    if (!placeholder) {
      return
    }
    let applied = ''
    // Per frame: a pane can move without resizing, and overlays open without any event here.
    const sync = (): void => {
      const rect = placeholder.getBoundingClientRect()
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        placeholder.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      const covered =
        visible && (isWebviewDragPassthroughActive() || hasVisibleOverlayOver(rect, placeholder))
      const next = !visible
        ? 'hidden'
        : covered
          ? 'covered'
          : // Device pixel ratio: a UI zoom change moves the view without changing CSS px.
            `${rect.left}|${rect.top}|${rect.width}|${rect.height}|${window.devicePixelRatio}`
      if (next === applied) {
        return
      }
      applied = next
      if (!visible || covered) {
        void window.api.browser
          .setDevToolsDockBounds({ browserPageId, bounds: null, snapshot: covered })
          .then((url) => {
            if (url && applied === 'covered') {
              setSnapshot({ url, width: rect.width, height: rect.height })
            }
          })
        return
      }
      setSnapshot(null)
      void window.api.browser.setDevToolsDockBounds({
        browserPageId,
        bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      })
    }
    const releaseSync = registerBrowserClientPagePositionSync(sync)
    sync()
    return () => {
      releaseSync()
      void window.api.browser.setDevToolsDockBounds({ browserPageId, bounds: null })
    }
  }, [browserPageId, placeholder])
  return snapshot
}
