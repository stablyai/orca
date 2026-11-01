import { redactKagiSessionToken } from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import type { BrowserPageFailLoadEvent } from '../describe-page/browser-page-types'

/** Use the current guest URL when validatedURL is absent; a lazy fallback avoids guest reads for ignored events. */
export function resolveBrowserWebviewLoadFailure(
  event: BrowserPageFailLoadEvent,
  options: { fallbackUrl?: string | null | (() => string | null) } = {}
): BrowserLoadError | null {
  // ERR_ABORTED covers successful redirect/cancel races; subframe failures must not blank the page.
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
