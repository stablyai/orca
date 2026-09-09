import { normalizeBrowserNavigationUrl } from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { isChromiumErrorPage } from '../describe-page/browser-page-url-display'

/**
 * The failure a pane should still be reporting now that its guest sits on `currentUrl`.
 *
 * A retained guest outlives the pane that renders it, so a remount can meet a guest that
 * navigated on while nothing was listening. Re-checking the recorded failure against where the
 * guest actually is keeps a standing failure alive and drops one the guest has moved past —
 * the reconciliation the local pane already does at did-stop-loading.
 */
export function resolveActiveBrowserLoadFailure(
  failure: BrowserLoadError | null | undefined,
  currentUrl: string
): BrowserLoadError | null {
  if (!failure) {
    return null
  }
  // Why: a guest still painting the error page reports chrome-error://chromewebdata/, never the
  // URL that failed — so a URL comparison here would read the standing failure as gone.
  if (isChromiumErrorPage(currentUrl)) {
    return failure
  }
  const attemptedUrl = normalizeBrowserNavigationUrl(failure.validatedUrl) ?? failure.validatedUrl
  const guestUrl = normalizeBrowserNavigationUrl(currentUrl) ?? currentUrl
  return attemptedUrl === guestUrl ? failure : null
}
