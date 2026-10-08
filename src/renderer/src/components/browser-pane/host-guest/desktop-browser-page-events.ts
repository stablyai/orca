import type {
  DesktopBrowserViewEvent,
  DesktopBrowserViewState
} from '../../../../../shared/desktop-browser-view-protocol'
import { BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX } from '../../../../../shared/browser-annotation-viewport-bridge'
import type { DesktopBrowserPage } from './desktop-browser-page-registry'
import type { BrowserPageNavigationSource } from './browser-page-navigation-source'
import {
  createBrowserPageWebviewNavigationHandlers,
  type BrowserPageWebviewNavigationHandlersArgs
} from './browser-page-webview-navigation-handlers'
import {
  createBrowserPageWebviewLoadingHandlers,
  type BrowserPageWebviewLoadingHandlersArgs
} from './browser-page-webview-loading-handlers'

export type DesktopBrowserPageEventsArgs = Omit<
  BrowserPageWebviewNavigationHandlersArgs & BrowserPageWebviewLoadingHandlersArgs,
  'webview'
> & {
  onReady: () => void
  onGone: (reason: string) => void
  onFocus: () => void
  onZoom: (level: number) => void
  onFullNavigation: () => void
}

/** Shares browser chrome behavior while reading the native guest's observed state. */
export function bindDesktopBrowserPageEvents(
  page: DesktopBrowserPage,
  args: DesktopBrowserPageEventsArgs
): () => void {
  const source: BrowserPageNavigationSource = {
    getURL: () => page.state.url,
    getTitle: () => page.state.title,
    canGoBack: () => page.state.canGoBack,
    canGoForward: () => page.state.canGoForward,
    get src() {
      return page.args.url
    }
  }
  const navigation = createBrowserPageWebviewNavigationHandlers({ ...args, webview: source })
  const loading = createBrowserPageWebviewLoadingHandlers({ ...args, webview: source })
  let previous: DesktopBrowserViewState | null = null
  const acceptState = (state: DesktopBrowserViewState): void => {
    if (previous && state.revision <= previous.revision) {
      return
    }
    const before = previous
    previous = state
    if (state.loading && !before?.loading) {
      loading.handleDidStartLoading()
    }
    if (
      state.loadError &&
      (state.loadError.code !== before?.loadError?.code ||
        state.loadError.validatedUrl !== before?.loadError?.validatedUrl)
    ) {
      loading.handleFailLoad({
        errorCode: state.loadError.code,
        errorDescription: state.loadError.description,
        validatedURL: state.loadError.validatedUrl,
        isMainFrame: true
      })
    }
    if (state.faviconUrl !== before?.faviconUrl) {
      navigation.handleFaviconUpdate({ favicons: state.faviconUrl ? [state.faviconUrl] : [] })
    }
    if (state.title !== before?.title) {
      navigation.handleTitleUpdate({ title: state.title })
    }
    if (!state.loading && (before?.loading || !before)) {
      loading.handleDidStopLoading()
    }
    args.onUpdatePageStateRef.current(args.browserTabId, {
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward
    })
    if (state.focused && !before?.focused) {
      args.onFocus()
    }
    if (state.zoomLevel !== before?.zoomLevel) {
      args.onZoom(state.zoomLevel)
    }
  }
  const accept = (event: DesktopBrowserViewEvent): void => {
    switch (event.kind) {
      case 'state':
        acceptState(event.state)
        break
      case 'navigation-start':
        navigation.handleDidStartNavigation({
          isMainFrame: true,
          isInPlace: event.sameDocument,
          url: event.url
        })
        break
      case 'navigation-commit':
        if (event.sameDocument) {
          navigation.handleDidNavigateInPage({ url: event.url })
        } else {
          navigation.handleFullDidNavigate({ url: event.url })
          args.onFullNavigation()
        }
        break
      case 'page-ready':
        args.onReady()
        break
      case 'renderer-gone':
        args.onGone(event.reason)
        break
      case 'destroyed':
        args.onGone('destroyed')
        break
      case 'annotation-viewport':
        navigation.handleAnnotationViewportMessage({
          message: `${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}${event.token}:${JSON.stringify({ scrollX: event.scrollX, scrollY: event.scrollY })}`
        })
        break
      case 'found-in-page':
        // Find results are handled by the surface's dedicated subscription.
        break
    }
  }
  const unsubscribe = page.subscribe(accept)
  acceptState(page.state)
  if (page.destroyed) {
    args.onGone('destroyed')
  } else if (page.ready) {
    args.onReady()
  }
  return unsubscribe
}
