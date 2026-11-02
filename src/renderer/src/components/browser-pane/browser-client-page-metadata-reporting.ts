import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import { e2eSuppressesBrowserClientPageMetadataPublish } from './browser-client-page-metadata-publish-e2e-fault'
import {
  createBrowserClientPageMetadataPublisher,
  type BrowserClientPageMetadataUnpublished
} from './browser-client-page-metadata-publisher'

/** Warn once per page/reason: failed metadata leaves runtime, peers and recovery at the starting URL, but navigation-frequency logging would bury the signal. */
const warnedByPageId = new Map<string, Set<string>>()

export function reportUnpublishedBrowserClientPageMetadata(
  browserPageId: string,
  detail: BrowserClientPageMetadataUnpublished
): void {
  const key = detail.reason === 'failed' ? `failed:${detail.errorCode}` : detail.reason
  let warned = warnedByPageId.get(browserPageId)
  if (!warned) {
    warned = new Set()
    warnedByPageId.set(browserPageId, warned)
  }
  if (warned.has(key)) {
    return
  }
  warned.add(key)
  console.warn('[browser-client-page] metadata publish did not land:', { browserPageId, ...detail })
}

/** Publish through main’s host lease; direct renderer calls are refused as stale. */
export function startBrowserClientPageMetadataPublisher(options: {
  browserPageId: string
  environmentId: string
  placement: RuntimeBrowserClientPlacement
  nextRevision: () => number
}): ReturnType<typeof createBrowserClientPageMetadataPublisher> {
  return createBrowserClientPageMetadataPublisher({
    browserPageId: options.browserPageId,
    placement: options.placement,
    nextRevision: options.nextRevision,
    publish: (params) =>
      e2eSuppressesBrowserClientPageMetadataPublish()
        ? Promise.resolve({ status: 'refused' as const })
        : window.api.browser.publishClientPageMetadata({
            environmentId: options.environmentId,
            params
          }),
    onUnpublished: (detail) =>
      reportUnpublishedBrowserClientPageMetadata(options.browserPageId, detail)
  })
}

export function forgetBrowserClientPageMetadataReports(browserPageId: string): void {
  warnedByPageId.delete(browserPageId)
}
