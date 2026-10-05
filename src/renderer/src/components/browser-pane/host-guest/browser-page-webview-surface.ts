import type { RefObject } from 'react'
import type { BrowserPageZoomDirection } from '../../../../../shared/browser-page-zoom'
import {
  nextBrowserPageZoomLevel,
  normalizeBrowserPageZoomLevel
} from '../../../../../shared/browser-page-zoom'
import type {
  BrowserPageSurface,
  BrowserPageSurfaceBounds,
  BrowserPageSurfaceFindResult,
  BrowserPageSurfaceSnapshot,
  BrowserPageSurfaceViewportCapture
} from './browser-page-surface'

function withWebview<T>(
  webviewRef: RefObject<Electron.WebviewTag | null>,
  operation: (webview: Electron.WebviewTag) => T
): T | null {
  const webview = webviewRef.current
  if (!webview) {
    return null
  }
  try {
    return operation(webview)
  } catch {
    return null
  }
}

export function createWebviewBrowserPageSurface(
  webviewRef: RefObject<Electron.WebviewTag | null>
): BrowserPageSurface {
  const findSubscriptions = new Map<
    (result: BrowserPageSurfaceFindResult) => void,
    {
      listener: ((event: Electron.FoundInPageEvent) => void) | null
      webview: Electron.WebviewTag | null
    }
  >()

  const refreshFindSubscriptions = (): void => {
    const current = webviewRef.current
    for (const [callback, subscription] of findSubscriptions) {
      if (subscription.webview === current) {
        continue
      }
      if (subscription.webview && subscription.listener) {
        try {
          subscription.webview.removeEventListener('found-in-page', subscription.listener)
        } catch {
          // Why: a destroyed guest can reject late listener cleanup.
        }
      }
      if (!current) {
        findSubscriptions.set(callback, { listener: null, webview: null })
        continue
      }
      const listener = (event: Electron.FoundInPageEvent): void => {
        callback({
          activeMatchOrdinal: event.result.activeMatchOrdinal,
          matches: event.result.matches
        })
      }
      try {
        current.addEventListener('found-in-page', listener)
        findSubscriptions.set(callback, { listener, webview: current })
      } catch {
        findSubscriptions.set(callback, { listener: null, webview: null })
      }
    }
  }

  const withCurrentWebview = <T>(operation: (webview: Electron.WebviewTag) => T): T | null => {
    refreshFindSubscriptions()
    return withWebview(webviewRef, operation)
  }

  return {
    blur: () => {
      void withCurrentWebview((webview) => webview.blur())
    },
    focus: () =>
      withCurrentWebview((webview) => {
        webview.focus()
        return document.activeElement === webview
      }) ?? false,
    captureViewport: async (): Promise<BrowserPageSurfaceViewportCapture | null> => {
      const webview = webviewRef.current
      if (!webview) {
        return null
      }
      const native = await webview.capturePage()
      if (native.isEmpty()) {
        return null
      }
      const { height, width } = native.getSize()
      return { dataUrl: native.toDataURL(), height, width }
    },
    getBounds: () =>
      withCurrentWebview((webview): BrowserPageSurfaceBounds => {
        const bounds = webview.getBoundingClientRect()
        return { height: bounds.height, left: bounds.left, top: bounds.top, width: bounds.width }
      }),
    getSnapshot: () =>
      withCurrentWebview((webview): BrowserPageSurfaceSnapshot => ({
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
        loading: webview.isLoading(),
        title: webview.getTitle(),
        url: webview.getURL(),
        zoomLevel: webview.getZoomLevel()
      })),
    goBack: () => {
      void withCurrentWebview((webview) => webview.goBack())
    },
    goForward: () => {
      void withCurrentWebview((webview) => webview.goForward())
    },
    isAttached: () => webviewRef.current !== null,
    navigate: (url) => {
      void withCurrentWebview((webview) => {
        webview.src = url
      })
    },
    refresh: refreshFindSubscriptions,
    reload: (ignoreCache) => {
      void withCurrentWebview((webview) =>
        ignoreCache ? webview.reloadIgnoringCache() : webview.reload()
      )
    },
    runFind: (text, options) => {
      if (!text) {
        return
      }
      void withCurrentWebview((webview) => webview.findInPage(text, options))
    },
    setZoomLevel: (level) =>
      withCurrentWebview((webview) => {
        const next = normalizeBrowserPageZoomLevel(level)
        if (normalizeBrowserPageZoomLevel(webview.getZoomLevel()) !== next) {
          webview.setZoomLevel(next)
        }
        return next
      }),
    stepZoom: (direction: BrowserPageZoomDirection, resetLevel) =>
      withCurrentWebview((webview) => {
        const next = nextBrowserPageZoomLevel(webview.getZoomLevel(), direction, resetLevel)
        webview.setZoomLevel(next)
        return next
      }),
    stop: () => {
      void withCurrentWebview((webview) => webview.stop())
    },
    stopFind: (action = 'clearSelection') => {
      void withCurrentWebview((webview) => webview.stopFindInPage(action))
    },
    subscribeFindResults: (callback) => {
      const existing = findSubscriptions.get(callback)
      if (!existing) {
        findSubscriptions.set(callback, { listener: null, webview: null })
      }
      refreshFindSubscriptions()
      return () => {
        const subscription = findSubscriptions.get(callback)
        findSubscriptions.delete(callback)
        if (!subscription?.webview || !subscription.listener) {
          return
        }
        try {
          subscription.webview.removeEventListener('found-in-page', subscription.listener)
        } catch {
          // Why: a destroyed guest can reject late listener cleanup.
        }
      }
    }
  }
}
