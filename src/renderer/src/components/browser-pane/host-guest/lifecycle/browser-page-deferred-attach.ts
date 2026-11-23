import type { MutableRefObject } from 'react'
import { issueBrowserGuestNavigation } from '../metadata/browser-guest-metadata-cache'

/**
 * Attaches a new tab's page once main answers, which it does when the page's profile has started
 * its extensions: until then there is no guest, so nothing can make a request an extension loading
 * would drop. An address entered meanwhile (kept unredacted) is the one the page opens with.
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
  webview.dataset.orcaAttachPageId = browserTabId
  const prepare = (url: string): Promise<string> => prepareBrowserPageAttach(webview, url)
  // Extensions are up after the first answer, so a re-prepare for a newer address answers at once.
  const prepareLatest = async (): Promise<string> => {
    let marker = await prepare(initialUrl)
    let preparedUrl = initialUrl
    for (
      let requestedUrl = webview.dataset.orcaAttachRequestedUrl;
      // A closed or replaced tab's webview leaves the document; re-preparing would recreate its page.
      requestedUrl && requestedUrl !== preparedUrl && webview.isConnected;
      requestedUrl = webview.dataset.orcaAttachRequestedUrl
    ) {
      lastKnownWebviewUrlRef.current = requestedUrl
      preparedUrl = requestedUrl
      marker = await prepare(requestedUrl)
    }
    delete webview.dataset.orcaAttachRequestedUrl
    return marker
  }
  void prepareLatest()
    .then((marker) => {
      delete webview.dataset.orcaAttachWaiting
      if (webview.dataset.orcaAttachStopped) {
        // Stopped while waiting: it opens on the next Reload.
        webview.dataset.orcaAttachStopped = marker
        return
      }
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

function prepareBrowserPageAttach(webview: Electron.WebviewTag, url: string): Promise<string> {
  return window.api.browser.preparePageAttach({
    browserPageId: webview.dataset.orcaAttachPageId ?? '',
    partition: webview.getAttribute('partition') ?? '',
    url
  })
}

/** Reload or a new address while it waits undoes an earlier Stop: it opens once ready. */
export function cancelBrowserPageAttachStop(webview: Electron.WebviewTag): void {
  delete webview.dataset.orcaAttachStopped
}

/**
 * A new address for a page that was stopped while it waited and never opened: it opens with that
 * address, through main, so the page stays the one main tracks. True when this handled it.
 */
export function openStoppedBrowserPageAttach(webview: Electron.WebviewTag, url: string): boolean {
  const marker = webview.dataset.orcaAttachStopped
  if (!marker || marker === 'true') {
    return false
  }
  delete webview.dataset.orcaAttachStopped
  void prepareBrowserPageAttach(webview, url).then((next) => {
    if (webview.isConnected) {
      issueBrowserGuestNavigation(webview, () => {
        webview.src = next
      })
    }
  })
  return true
}

/** Stop while it waits: once ready it stays unopened until a Reload. */
export function stopBrowserPageDeferredAttach(webview: Electron.WebviewTag): void {
  webview.dataset.orcaAttachStopped = 'true'
}

/** Reload after such a Stop: opens it (once ready). True when this handled the Reload. */
export function resumeStoppedBrowserPageAttach(webview: Electron.WebviewTag): boolean {
  const marker = webview.dataset.orcaAttachStopped
  if (!marker) {
    return false
  }
  delete webview.dataset.orcaAttachStopped
  // Still 'true': the wait failed after the Stop, so the ordinary Reload (recovery) takes over.
  if (marker === 'true') {
    return false
  }
  issueBrowserGuestNavigation(webview, () => {
    webview.src = marker
  })
  return true
}
