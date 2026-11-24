import type { MutableRefObject } from 'react'
import { issueBrowserGuestNavigation } from '../metadata/browser-guest-metadata-cache'

/**
 * Attaches a new tab's page once main answers, which it does when the page's profile has started
 * its extensions: until then there is no guest, so nothing can make a request an extension loading
 * would drop, and Stop and Reload have nothing to act on (at most 5 s). An address entered
 * meanwhile (kept unredacted) is the one the page opens with.
 */
export function startBrowserPageDeferredAttach({
  webview,
  browserTabId,
  initialUrl,
  lastKnownWebviewUrlRef,
  onFailed
}: {
  webview: Electron.WebviewTag
  browserTabId: string
  initialUrl: string
  lastKnownWebviewUrlRef: MutableRefObject<string | null>
  onFailed: () => void
}): void {
  webview.dataset.orcaAttachWaiting = 'true'
  const prepare = (url: string, first: boolean): Promise<string> =>
    window.api.browser.preparePageAttach({
      browserPageId: browserTabId,
      partition: webview.getAttribute('partition') ?? '',
      url,
      ...(first ? {} : { waited: true })
    })
  // The first answer ends the page's one wait, so a newer address entered meanwhile opens at once.
  const prepareLatest = async (): Promise<string> => {
    let marker = await prepare(initialUrl, true)
    let preparedUrl = initialUrl
    for (
      let requestedUrl = webview.dataset.orcaAttachRequestedUrl;
      // A closed or replaced tab's webview leaves the document; re-preparing would recreate its page.
      requestedUrl && requestedUrl !== preparedUrl && webview.isConnected;
      requestedUrl = webview.dataset.orcaAttachRequestedUrl
    ) {
      lastKnownWebviewUrlRef.current = requestedUrl
      preparedUrl = requestedUrl
      marker = await prepare(requestedUrl, false)
    }
    delete webview.dataset.orcaAttachRequestedUrl
    return marker
  }
  void prepareLatest()
    .then((marker) => {
      delete webview.dataset.orcaAttachWaiting
      // Why not the component's ref: a workspace switch remounts this tab onto the same webview.
      if (webview.isConnected) {
        issueBrowserGuestNavigation(webview, () => {
          webview.src = marker
        })
      } else {
        webview.dataset.orcaAttachMarker = marker
      }
    })
    .catch(() => {
      delete webview.dataset.orcaAttachWaiting
      onFailed()
    })
}

/** Still waiting for its profile's extensions: no page to drive or validate yet. */
export function isBrowserPageAttachWaiting(webview: Electron.WebviewTag): boolean {
  return webview.dataset.orcaAttachWaiting !== undefined
}

/** A tab remounted after its wait ended while it was out of the document attaches now. */
export function resumeParkedBrowserPageAttach(webview: Electron.WebviewTag): void {
  const marker = webview.dataset.orcaAttachMarker
  delete webview.dataset.orcaAttachMarker
  if (marker) {
    issueBrowserGuestNavigation(webview, () => {
      webview.src = marker
    })
  }
}

/** Attached while parked: its first load may have finished with no listener bound to see it. */
export function settleParkedBrowserPageAttach(webview: Electron.WebviewTag): void {
  if (!webview.dataset.orcaAttachPending) {
    return
  }
  try {
    if (!webview.isLoading()) {
      delete webview.dataset.orcaAttachPending
    }
  } catch {
    // No guest attached yet.
  }
}
