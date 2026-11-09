import { normalizeBrowserNavigationUrl } from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { isChromiumErrorPage } from '../describe-page/browser-page-url-display'

/** Retained guests can navigate while their pane is unmounted; drop failures they have moved past. */
export function resolveActiveBrowserLoadFailure(
  failure: BrowserLoadError | null | undefined,
  currentUrl: string
): BrowserLoadError | null {
  if (!failure) {
    return null
  }
  // Error pages report chrome-error://chromewebdata/ rather than the failed URL; preserve their standing failure.
  if (isChromiumErrorPage(currentUrl)) {
    return failure
  }
  const attemptedUrl = normalizeBrowserNavigationUrl(failure.validatedUrl) ?? failure.validatedUrl
  const guestUrl = normalizeBrowserNavigationUrl(currentUrl) ?? currentUrl
  return attemptedUrl === guestUrl ? failure : null
}
