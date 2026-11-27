import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import { MAX_CLEAN_CAPTURE_DEADLINE_MS } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import type { BrowserPage } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import { useGuestEscape } from '../../host-guest/input/use-guest-escape'
import { deliverMarkupToClipboard } from './markup-clipboard-delivery'
import {
  useMarkupMode,
  type MarkupCaptureContext,
  type MarkupModeController
} from './useMarkupMode'

function readGuestId(webview: Electron.WebviewTag): number | null {
  try {
    return webview.isConnected ? webview.getWebContentsId() : null
  } catch {
    return null
  }
}

/** The settled guest a clean capture may start on: null while it is detached, unreadable, or loading a document. */
function readCleanCaptureGuestId(webview: Electron.WebviewTag): number | null {
  try {
    return webview.isLoadingMainFrame() ? null : readGuestId(webview)
  } catch {
    return null
  }
}

/** A local browser page: main clears its picker before capturing, so Draw can start from Grab. */
export type LocalMarkupPage = {
  /** A page showing its load failure overlay has nothing to draw on. */
  page: Pick<BrowserPage, 'id' | 'loadError'>
  /** Visible in its pane; a capture whose pane is hidden publishes nothing. */
  isActive: boolean
}

export function useBrowserPageMarkupCapture(
  webviewRef: MutableRefObject<Electron.WebviewTag | null>,
  localPage?: LocalMarkupPage
): MarkupModeController {
  // Committed with the render, so a continuation that runs before passive effects still sees the hidden pane.
  const localPageRef = useRef(localPage)
  const mountedRef = useRef(true)
  useLayoutEffect(() => {
    localPageRef.current = localPage
  })
  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const cleanPageId = localPage?.page.id
  const markup = useMarkupMode({
    getCaptureContext: useCallback((): MarkupCaptureContext | null => {
      const webview = webviewRef.current
      if (!webview) {
        return null
      }
      const rect = webview.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        return null
      }
      const size = { cssWidth: rect.width, cssHeight: rect.height }
      const outputScale = window.devicePixelRatio || 1
      if (!cleanPageId) {
        return { source: { kind: 'webview', webview }, ...size, outputScale }
      }
      const eligible = (): boolean =>
        mountedRef.current &&
        localPageRef.current?.isActive === true &&
        localPageRef.current.page.loadError === null
      const guestId = readCleanCaptureGuestId(webview)
      if (guestId === null || !eligible()) {
        return null
      }
      return {
        source: {
          kind: 'clean-page',
          browserPageId: cleanPageId,
          guestId,
          deadlineMs: Date.now() + MAX_CLEAN_CAPTURE_DEADLINE_MS
        },
        ...size,
        outputScale,
        // The same element and guest the capture began on, in a pane still shown; anything else is another page.
        isCurrent: () =>
          eligible() && webviewRef.current === webview && readGuestId(webview) === guestId
      }
    }, [cleanPageId, webviewRef]),
    onDeliver: deliverMarkupToClipboard
  })
  // Escape typed into the focused page ends a capture still in progress too.
  useGuestEscape(
    cleanPageId ?? '',
    cleanPageId !== undefined && markup.state === 'capturing',
    markup.cancel
  )
  // Layout, not passive: a pane hidden in this commit drops its capture before any continuation can publish.
  const hidden = localPage?.isActive === false
  const { abandonCapture } = markup
  useLayoutEffect(() => {
    if (hidden) {
      abandonCapture()
    }
  }, [abandonCapture, hidden])
  return markup
}
