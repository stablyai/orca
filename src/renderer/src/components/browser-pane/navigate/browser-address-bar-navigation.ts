import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import { parseChromeExtensionUrl } from '../../../../../shared/browser-extension-url'

export type BrowserAddressBarSubmission =
  | { status: 'navigate'; url: string }
  | { status: 'invalid'; loadError: BrowserLoadError }

/**
 * Every browser pane resolves typed address-bar input here, so search fallback, the
 * Kagi session link and the invalid-input failure cannot drift between backends.
 * Callers stay responsible for routing the two outcomes into their own chrome.
 */
export function resolveBrowserAddressBarSubmission(
  rawValue: string,
  options?: { allowFileUrls?: boolean; allowExtensionPages?: boolean }
): BrowserAddressBarSubmission {
  // Why opt-in: only a local browser-profile tab can host an extension page; main's session decides
  // whether that extension is on, and Chromium refuses pages of extensions the session never loaded.
  const extensionUrl = options?.allowExtensionPages
    ? parseChromeExtensionUrl(rawValue.trim())
    : null
  if (extensionUrl) {
    return { status: 'navigate', url: extensionUrl.url }
  }
  const { browserDefaultSearchEngine, browserKagiSessionLink } = useAppStore.getState()
  // Why: the search-engine argument opts into search fallback; without it typed
  // queries parse as hosts ("google maps" -> https://google%20maps/).
  const url = normalizeBrowserNavigationUrl(rawValue, browserDefaultSearchEngine, {
    kagiSessionLink: browserKagiSessionLink
  })
  // Why: client-hosted guests refuse file: by design (a remote page must not probe
  // this machine's disk). Saying so beats the blank tab that refusal used to produce.
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
