import type {
  BrowserClientPageMetadataParams,
  BrowserClientPageMetadataPublishOutcome
} from '../../../../shared/browser-client-page-metadata-protocol'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'

export type BrowserClientPageMetadataSnapshot = Pick<
  BrowserClientPageMetadataParams,
  'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward'
>

/**
 * Hands the params to whatever can reach the runtime's browser-host lease. That is main, not this
 * renderer: the runtime only accepts page traffic on the lease's own connection.
 */
type BrowserClientPageMetadataPublish = (
  params: BrowserClientPageMetadataParams
) => Promise<BrowserClientPageMetadataPublishOutcome>

/**
 * Why a publish that did not land is surfaced: a metadata publish is the only thing that moves the
 * runtime's copy of a client-hosted page off the URL it was created with, and a silent failure here
 * reads downstream as a page that simply never navigated.
 */
export type BrowserClientPageMetadataUnpublished =
  /** Delivered, but the runtime declined it — usually a revision it has already passed. */
  { reason: 'rejected' } | { reason: 'failed'; errorCode: string }

export function createBrowserClientPageMetadataPublisher(options: {
  browserPageId: string
  placement: RuntimeBrowserClientPlacement
  nextRevision: () => number
  publish: BrowserClientPageMetadataPublish
  onUnpublished?: (detail: BrowserClientPageMetadataUnpublished) => void
}): {
  publish(snapshot: BrowserClientPageMetadataSnapshot): void
  dispose(): void
} {
  let disposed = false
  let inFlight = false
  let pending: BrowserClientPageMetadataSnapshot | null = null

  const settle = (): void => {
    inFlight = false
    if (disposed) {
      pending = null
      return
    }
    const next = pending
    pending = null
    if (next) {
      send(next)
    }
  }

  const send = (snapshot: BrowserClientPageMetadataSnapshot): void => {
    inFlight = true
    let request: Promise<BrowserClientPageMetadataPublishOutcome>
    try {
      // Why the revision is minted inside the try: it is drawn from the page's live attachment and
      // throws once that page is detached. Outside, the throw escapes into a webview event handler
      // and leaves this publisher wedged with nothing in flight to release it.
      request = options.publish({
        browserHostClientId: options.placement.browserHostClientId,
        browserHostGeneration: options.placement.browserHostGeneration,
        browserPageId: options.browserPageId,
        pageHostGeneration: options.placement.pageHostGeneration,
        revision: options.nextRevision(),
        ...snapshot
      })
    } catch (error) {
      request = Promise.reject(error)
    }
    void request
      .then((outcome) => {
        if (outcome.status === 'published') {
          if (!outcome.accepted) {
            options.onUnpublished?.({ reason: 'rejected' })
          }
          return
        }
        options.onUnpublished?.({
          reason: 'failed',
          errorCode:
            outcome.status === 'failed' ? outcome.errorCode : 'browser_client_page_metadata_refused'
        })
      })
      .catch((error: unknown) => {
        options.onUnpublished?.({
          reason: 'failed',
          errorCode: error instanceof Error ? error.message : 'browser_client_page_metadata_failed'
        })
      })
      .finally(settle)
  }

  return {
    publish: (snapshot) => {
      if (disposed) {
        return
      }
      const fullSnapshot = { ...snapshot }
      if (inFlight) {
        pending = fullSnapshot
        return
      }
      send(fullSnapshot)
    },
    dispose: () => {
      disposed = true
      pending = null
    }
  }
}
