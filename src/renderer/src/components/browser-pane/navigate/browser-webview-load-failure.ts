import { redactKagiSessionToken } from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import type { BrowserPageFailLoadEvent } from '../describe-page/browser-page-types'

/**
 * Turns a webview `did-fail-load` into the failure the overlay renders, or null when the
 * event must be swallowed. Every webview-backed pane routes through this so a new backend
 * cannot forget the ignore rules or build a differently-shaped BrowserLoadError.
 *
 * `fallbackUrl` covers failures that arrive without a validatedURL — pass the webview's
 * current URL so the overlay names the page instead of about:blank. Pass it as a function when
 * reading it costs anything: discarded events never ask for it.
 */
export function resolveBrowserWebviewLoadFailure(
  event: BrowserPageFailLoadEvent,
  options: { fallbackUrl?: string | null | (() => string | null) } = {}
): BrowserLoadError | null {
  // Why: Chromium reports redirect/cancel races as ERR_ABORTED (-3) even when the
  // replacement navigation succeeds; subframe failures never blank the page.
  if (event.isMainFrame === false || event.errorCode === -3) {
    return null
  }
  const fallbackUrl =
    typeof options.fallbackUrl === 'function' ? options.fallbackUrl() : options.fallbackUrl
  return {
    code: event.errorCode ?? -1,
    description: event.errorDescription || 'Unknown load failure',
    validatedUrl: redactKagiSessionToken(event.validatedURL || fallbackUrl || 'about:blank')
  }
}
