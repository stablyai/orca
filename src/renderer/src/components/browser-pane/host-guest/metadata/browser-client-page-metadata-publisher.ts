import type {
  BrowserClientPageMetadataParams,
  BrowserClientPageMetadataPublishOutcome
} from '../../../../../../shared/browser/client-hosting/browser-client-page-metadata-protocol'
import type { RuntimeBrowserClientPlacement } from '../../../../../../shared/browser/client-hosting/runtime-browser-placement'
import { remoteTabFaviconUrl } from '../../../../../../shared/browser/browser-favicon-url'

export type BrowserClientPageMetadataSnapshot = Pick<
  BrowserClientPageMetadataParams,
  'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward'
>
type PublishedMetadata = BrowserClientPageMetadataSnapshot &
  Pick<BrowserClientPageMetadataParams, 'faviconUrl'>

/** Main holds the host lease; the runtime accepts page traffic only on that connection. */
type BrowserClientPageMetadataPublish = (
  params: BrowserClientPageMetadataParams
) => Promise<BrowserClientPageMetadataPublishOutcome>

/** A failed publish leaves the runtime at the original URL, indistinguishable from a page that never navigated unless surfaced. */
export type BrowserClientPageMetadataUnpublished =
  /** Delivered, but the runtime declined it — usually a revision it has already passed. */
  { reason: 'rejected' } | { reason: 'failed'; errorCode: string }

export function createBrowserClientPageMetadataPublisher(options: {
  browserPageId: string
  placement: RuntimeBrowserClientPlacement
  nextRevision: () => number
  /** The page's icon when the publisher starts, since a retained guest sends no new icon event. */
  faviconUrl: string | null
  publish: BrowserClientPageMetadataPublish
  onUnpublished?: (detail: BrowserClientPageMetadataUnpublished) => void
}): {
  publish(snapshot: BrowserClientPageMetadataSnapshot): void
  /** Icons arrive between metadata events, so gaining or losing one resends the last snapshot. */
  publishFavicon(faviconUrl: string | null): void
  dispose(): void
} {
  let disposed = false
  let inFlight = false
  let pending: PublishedMetadata | null = null
  let last: BrowserClientPageMetadataSnapshot | null = null
  let faviconUrl = remoteTabFaviconUrl(options.faviconUrl)

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

  const send = (snapshot: PublishedMetadata): void => {
    inFlight = true
    let request: Promise<BrowserClientPageMetadataPublishOutcome>
    try {
      // Mint revisions inside try: detach can make the counter throw, and an uncaught throw would wedge the in-flight slot.
      request = options.publish({
        browserHostClientId: options.placement.browserHostClientId,
        browserHostGeneration: options.placement.browserHostGeneration,
        browserPageId: options.browserPageId,
        pageHostGeneration: options.placement.pageHostGeneration,
        revision: options.nextRevision(),
        ...snapshot,
        title: snapshot.title.slice(0, 4096)
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

  const publish = (snapshot: BrowserClientPageMetadataSnapshot): void => {
    if (disposed) {
      return
    }
    last = snapshot
    const fullSnapshot = { ...snapshot, faviconUrl }
    if (inFlight) {
      pending = fullSnapshot
      return
    }
    send(fullSnapshot)
  }

  return {
    publish,
    publishFavicon: (next) => {
      // The runtime rejects an over-long icon, which would drop the whole update with it.
      const safe = remoteTabFaviconUrl(next)
      const arrivedOrCleared = (safe === null) !== (faviconUrl === null)
      faviconUrl = safe
      // Animated icons swap many times a second, so a swap rides the next metadata publish.
      if (arrivedOrCleared && last) {
        publish(last)
      }
    },
    dispose: () => {
      disposed = true
      pending = null
    }
  }
}
