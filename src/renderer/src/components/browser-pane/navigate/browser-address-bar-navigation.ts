import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'

export type BrowserAddressBarSubmission =
  | { status: 'navigate'; url: string }
  | { status: 'invalid'; loadError: BrowserLoadError }

/** Share search fallback, Kagi handling and invalid-input failures across browser backends. */
export function resolveBrowserAddressBarSubmission(
  rawValue: string,
  options?: { allowFileUrls?: boolean }
): BrowserAddressBarSubmission {
  const { browserDefaultSearchEngine, browserKagiSessionLink } = useAppStore.getState()
  // Passing the search engine enables query fallback; otherwise “google maps” becomes a host.
  const url = normalizeBrowserNavigationUrl(rawValue, browserDefaultSearchEngine, {
    kagiSessionLink: browserKagiSessionLink
  })
  // Client-hosted pages must not probe this machine’s disk; surface file: refusal instead of leaving a blank tab.
  const fileUrlUnsupported =
    options?.allowFileUrls === false && Boolean(url) && url!.startsWith('file:')
  if (url && !fileUrlUnsupported) {
    return { status: 'navigate', url }
  }
  return {
    status: 'invalid',
    loadError: {
      code: 0,
      description: fileUrlUnsupported
        ? translate(
            'auto.components.browser.pane.BrowserPane.fileUrlUnsupported',
            'This browser tab cannot open local files. Use "Open Preview to the Side" on the file instead.'
          )
        : translate(
            'auto.components.browser.pane.BrowserPane.87eb75f7d2',
            'Enter a valid http(s) or localhost URL.'
          ),
      // Why: validatedUrl is persisted, so redact a possible Kagi session token first.
      validatedUrl: redactKagiSessionToken(rawValue.trim()) || 'about:blank'
    }
  }
}
