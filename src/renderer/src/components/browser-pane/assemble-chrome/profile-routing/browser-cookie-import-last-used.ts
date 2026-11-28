import type { BrowserCookieImportSource } from './browser-cookie-import-picker-rows'

// Every page imports this desktop's browsers, so one remembered source serves them all.
const LAST_USED_KEY = 'orca.browser.cookieImport.lastUsedSource'

export function readBrowserCookieImportLastUsed(): BrowserCookieImportSource | null {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(LAST_USED_KEY) ?? 'null')
    if (
      stored &&
      typeof stored === 'object' &&
      'family' in stored &&
      typeof stored.family === 'string' &&
      'profile' in stored &&
      (stored.profile === null || typeof stored.profile === 'string')
    ) {
      return { family: stored.family, profile: stored.profile }
    }
  } catch {}
  return null
}

export function rememberBrowserCookieImportLastUsed(source: BrowserCookieImportSource): void {
  try {
    window.localStorage.setItem(
      LAST_USED_KEY,
      JSON.stringify({ family: source.family, profile: source.profile })
    )
  } catch {}
}
